// account-meter, reporter mode: reports the estimated cost (USD, Claude Code's
// own estimate at list price) of this process per Claude account to
// claude-accounts (CONTRACT-2.md). Engine APIs only: no shell, no child
// process, no model request, nothing persisted. Nothing here may disturb the
// session: every failure ends in silence.
import type {
  EngineInterface, HttpInit, HttpResponse, SessionEndInput, SessionRateLimit, TurnCompleteInput, TurnStartInput,
} from 'claude-code'
import { hmacSha256Hex, randomHex, sha256Hex, utf8 } from './crypto'

// The only address this plugin sends to (scripts/check-surface.sh checks it).
export const REPORT_URL = 'https://claude-accounts.k8s.backbone.canou.io/report/v1/usage'
// At most one request per account this often; everything in between is bundled.
export const SEND_EVERY_MS = 60_000
export const FETCH_TIMEOUT_MS = 15_000
// 422 unknown_account: the account is not (yet) in claude-accounts.
export const REST_MS = 60 * 60_000
export const MAX_ITEMS = 20
export const MAX_ITEM_USD = 25
const MAX_BODY_BYTES = 8192
// What session.end's short bound keeps for the engine's own end step.
const END_RESERVE_MS = 250
const MAX_OPEN_TURNS = 64
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Identity = { uuid: string; key: string; email: string | null }
export type Check = { five_hour_resets_at?: number; seven_day_resets_at?: number }
export type Item = { readonly seq: number; readonly cost_delta_usd: number; readonly check?: Readonly<Check> }

// One account of this process: what is collected but not sent yet (`draft`,
// it may still grow) and the items sent at least once (fixed from then on).
type Account = {
  who: Identity
  draft: number
  check: Check | undefined
  items: Item[]
  restUntil: number
  muted: boolean
  maxItems: number
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const round6 = (usd: number) => Math.round(usd * 1e6) / 1e6
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// Canonical form of the contract: trimmed, lower case, with dashes.
export function normalizeUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return UUID.test(s) ? s : null
}

export function reportKey(uuid: string): string {
  return sha256Hex(`claude-accounts:${uuid}`).slice(0, 16)
}

export function signature(uuid: string, time: string, body: string): string {
  return hmacSha256Hex(uuid, `${time}\n${body}`)
}

export function buildBody(processId: string, version: string, items: readonly Item[]): string {
  return JSON.stringify({ schema: 1, process: processId, claude_version: version, items })
}

// The home folder, found without reading HOME (the reporter reads no
// environment variable but CLAUDE_CONFIG_DIR): a marketplace install lives in
// <home>/.claude/plugins/..., a folder plugin (--plugin-dir) is taken by the OS
// convention /Users/<name>, /home/<name>, /root or C:\Users\<name>.
export function homeFromRoot(root: string): string | null {
  const sep = root.includes('/') ? '/' : '\\'
  const parts = root.split(sep)
  const i = parts.findIndex((p, k) => p === '.claude' && parts[k + 1] === 'plugins')
  if (i > 0) return parts.slice(0, i).join(sep) || null
  const m = sep === '/'
    ? /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(\/|$)/.exec(root)
    : /^([A-Za-z]:\\Users\\[^\\]+)(\\|$)/.exec(root)
  return m ? m[1]! : null
}

function joinPath(dir: string, name: string): string {
  const sep = !dir.includes('/') && dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

// The reset times of the turn's rate limits, for the app's cross-check
// against the box measurement; only times still ahead.
export function checkFrom(limits: readonly SessionRateLimit[], nowSec: number): Check | undefined {
  const c: Check = {}
  for (const l of limits) {
    const field = l.kind === 'five_hour' ? 'five_hour_resets_at' : l.kind === 'seven_day' ? 'seven_day_resets_at' : null
    if (!field || !l.resetsAt) continue
    const t = Math.floor(Date.parse(l.resetsAt) / 1000)
    if (Number.isFinite(t) && t > nowSec) c[field] = t
  }
  return future(c, nowSec)
}

function future(c: Check | undefined, nowSec: number): Check | undefined {
  if (!c) return undefined
  const out: Check = {}
  if (c.five_hour_resets_at !== undefined && c.five_hour_resets_at > nowSec) out.five_hour_resets_at = c.five_hour_resets_at
  if (c.seven_day_resets_at !== undefined && c.seven_day_resets_at > nowSec) out.seven_day_resets_at = c.seven_day_resets_at
  return out.five_hour_resets_at !== undefined || out.seven_day_resets_at !== undefined ? out : undefined
}

// The answer as the contract's table reads it. Only a 200 with a JSON receipt
// settles items; whatever else is not named there is worth another try.
export type Outcome =
  | { kind: 'receipt'; done: number[]; counts: Record<string, number> }
  | { kind: 'invalid' | 'too_large' | 'unknown_account' | 'mismatch' | 'clock' }
  | { kind: 'retry'; why: string }

const SETTLED = new Set(['ok', 'duplicate', 'rejected'])

export function classify(res: { status: number; text: string } | null): Outcome {
  if (!res) return { kind: 'retry', why: 'no answer (timeout or network)' }
  let body: unknown = null
  try {
    body = JSON.parse(res.text)
  } catch {
    // not JSON
  }
  const error = isObj(body) && typeof body.error === 'string' ? body.error : null
  switch (res.status) {
    case 200: {
      if (!isObj(body) || !Array.isArray(body.results)) return { kind: 'retry', why: '200 without a receipt' }
      const done: number[] = []
      const counts: Record<string, number> = {}
      for (const r of body.results) {
        if (!isObj(r) || typeof r.seq !== 'number' || typeof r.status !== 'string' || !SETTLED.has(r.status)) continue
        done.push(r.seq)
        counts[r.status] = (counts[r.status] ?? 0) + 1
      }
      return { kind: 'receipt', done, counts }
    }
    case 400:
      return error === 'invalid' ? { kind: 'invalid' } : { kind: 'retry', why: '400 without the contract error' }
    case 401:
      return error === 'clock' ? { kind: 'clock' } : { kind: 'retry', why: `401 ${error ?? 'without JSON'}` }
    case 413:
      return { kind: 'too_large' }
    case 422:
      if (error === 'unknown_account') return { kind: 'unknown_account' }
      if (error === 'mismatch') return { kind: 'mismatch' }
      return { kind: 'retry', why: `422 ${error ?? 'without JSON'}` }
    case 429:
      return { kind: 'retry', why: '429 rate_limited' }
    default:
      return { kind: 'retry', why: `HTTP ${res.status}${error ? ` ${error}` : ''}` }
  }
}

function describe(out: Outcome): string {
  switch (out.kind) {
    case 'receipt': {
      const parts = Object.entries(out.counts).map(([k, n]) => `${n} ${k}`)
      return `200, ${parts.length ? parts.join(', ') : 'no item confirmed'}`
    }
    case 'invalid': return '400 invalid, the items were dropped'
    case 'too_large': return '413 too_large, the next request is smaller'
    case 'unknown_account': return '422 unknown_account, this account rests for 1 h'
    case 'mismatch': return '422 mismatch, this account stays silent in this process'
    case 'clock': return '401 clock, sent again in the next round'
    case 'retry': return `${out.why}, sent again in the next round`
  }
}

// Resolves with p, or with null after ms (the clock's own wait, cancelled
// once p settles).
async function within<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T | null> {
  const cancel = new AbortController()
  const timeout = $.clock.sleep(Math.max(0, ms), { signal: cancel.signal }).then(() => null, () => null)
  try {
    return await Promise.race([p, timeout])
  } finally {
    cancel.abort()
  }
}

// The reporter of one plugin load (one process, or a reload of it); the
// functions below take it with `$`, as the engine wants `$` passed only to
// top-level functions.
export type Reporter = {
  processId: string
  seq: number
  version: string
  file: string | null | undefined
  stamp: string | null
  current: Identity | null
  fileNote: string
  // The session whose cost this process follows: the last sum seen, and who
  // worked at its latest turn.start.
  tracked: { sid: string; last: number; who: Identity | null } | null
  turns: Map<string, Identity | null>
  accounts: Map<string, Account>
  timer: { cancel: () => void } | null
  inflight: Promise<void> | null
  lastReport: { at: number; text: string } | null
  lastAnswer: { at: number; text: string } | null
  clockHint: boolean
  logged: Set<string>
}

export function newReporter(): Reporter {
  return {
    processId: randomHex(8), seq: 0, version: 'unknown',
    file: undefined, stamp: null, current: null, fileNote: 'not read yet',
    tracked: null, turns: new Map(), accounts: new Map(),
    timer: null, inflight: null, lastReport: null, lastAnswer: null, clockHint: false, logged: new Set(),
  }
}

function logOnce($: EngineInterface, r: Reporter, key: string, text: string): void {
  if (r.logged.has(key)) return
  r.logged.add(key)
  $.ui.log(`account-meter: ${text}`, { to: 'debug' })
}

async function accountFile($: EngineInterface, r: Reporter): Promise<string | null> {
  if (r.file !== undefined) return r.file
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const base = dir || homeFromRoot($.plugin.root)
  r.file = base ? joinPath(base, '.claude.json') : null
  return r.file
}

// Who this process works for, from oauthAccount in .claude.json. The file is
// read again only when it changed (a /login rewrites it, as does much else);
// an unreadable file counts as no account until it reads again.
async function identity($: EngineInterface, r: Reporter): Promise<Identity | null> {
  const path = await accountFile($, r)
  if (!path) {
    r.current = null
    r.fileNote = 'no home folder found for .claude.json'
    return null
  }
  let s: string
  try {
    const st = await $.fs.stat(path)
    s = `${st.mtimeMs}:${st.size}`
  } catch {
    r.stamp = null
    r.current = null
    r.fileNote = `${path} not found`
    return null
  }
  if (s === r.stamp) return r.current
  r.stamp = null
  const before = r.current
  r.current = null
  try {
    const cfg: unknown = JSON.parse(await $.fs.read(path))
    const acc = isObj(cfg) && isObj(cfg.oauthAccount) ? cfg.oauthAccount : null
    const uuid = normalizeUuid(acc?.accountUuid)
    const email = typeof acc?.emailAddress === 'string' ? acc.emailAddress : null
    if (uuid) r.current = { uuid, key: before?.uuid === uuid ? before.key : reportKey(uuid), email }
    r.fileNote = uuid ? path : `no oauthAccount.accountUuid in ${path}`
    r.stamp = s
  } catch {
    r.fileNote = `${path} unreadable, read again at the next turn`
  }
  return r.current
}

async function reading($: EngineInterface): Promise<{ usd: number | null; rateLimits: readonly SessionRateLimit[] }> {
  const u = await $.session.usage()
  const usd = u.cost?.usd
  return {
    usd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null,
    rateLimits: u.rateLimits ?? [],
  }
}

function book(r: Reporter, who: Identity, usd: number, check: Check | undefined): void {
  let acc = r.accounts.get(who.uuid)
  if (!acc) {
    acc = { who, draft: 0, check: undefined, items: [], restUntil: 0, muted: false, maxItems: MAX_ITEMS }
    r.accounts.set(who.uuid, acc)
  }
  acc.who = who
  if (acc.muted) return
  acc.draft += usd
  if (check) acc.check = check
}

// Turns what was collected into items; an item never changes after this.
function freeze(r: Reporter, acc: Account, nowSec: number): void {
  while (acc.items.length < acc.maxItems) {
    const usd = Math.min(round6(acc.draft), MAX_ITEM_USD)
    if (!(usd > 0)) break
    acc.draft -= usd
    const check = future(acc.check, nowSec)
    const seq = ++r.seq
    acc.items.push(Object.freeze(check
      ? { seq, cost_delta_usd: usd, check: Object.freeze(check) }
      : { seq, cost_delta_usd: usd }))
  }
  if (!(round6(acc.draft) > 0)) acc.check = undefined
}

function drop(acc: Account, batch: readonly Item[]): void {
  const gone = new Set(batch.map(i => i.seq))
  acc.items = acc.items.filter(i => !gone.has(i.seq))
}

// One request for one account; false when the round should stop here (the
// items stay and go again next round, in the same order).
async function sendOne($: EngineInterface, r: Reporter, acc: Account, timeoutMs: number): Promise<boolean> {
  let n = Math.min(acc.items.length, acc.maxItems)
  let body = buildBody(r.processId, r.version, acc.items.slice(0, n))
  while (n > 1 && utf8(body).length > MAX_BODY_BYTES) body = buildBody(r.processId, r.version, acc.items.slice(0, --n))
  const batch = acc.items.slice(0, n)
  const sentAt = await $.clock.now()
  const time = String(Math.floor(sentAt / 1000))
  const init: HttpInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Report-Key': acc.who.key,
      'X-Report-Time': time,
      'X-Report-Signature': signature(acc.who.uuid, time, body),
    },
    body,
  }
  const usd = batch.reduce((sum, i) => sum + i.cost_delta_usd, 0)
  r.lastReport = { at: sentAt, text: `${n} item(s), ${usd.toFixed(4)} USD for ${acc.who.email ?? acc.who.key}` }
  const res: HttpResponse | null = await within($, $.http.fetch(REPORT_URL, init).catch(() => null), timeoutMs)
  const out = classify(res)
  r.lastAnswer = { at: await $.clock.now(), text: describe(out) }
  switch (out.kind) {
    case 'receipt': {
      r.clockHint = false
      const done = new Set(out.done)
      acc.items = acc.items.filter(i => !done.has(i.seq))
      return true
    }
    case 'invalid':
      drop(acc, batch)
      logOnce($, r, 'invalid', 'claude-accounts refused a report as invalid (400), its items were dropped')
      return true
    case 'too_large':
      if (n > 1) {
        acc.maxItems = Math.max(1, Math.floor(n / 2))
        return false
      }
      drop(acc, batch)
      logOnce($, r, 'too_large', 'claude-accounts refused a single item as too large (413), it was dropped')
      return true
    case 'unknown_account':
      acc.restUntil = sentAt + REST_MS
      return true
    case 'mismatch':
      acc.muted = true
      acc.items = []
      acc.draft = 0
      acc.check = undefined
      return true
    case 'clock':
      r.clockHint = true
      return false
    case 'retry':
      return false
  }
}

async function sendAll($: EngineInterface, r: Reporter, timeoutMs: number): Promise<void> {
  const now = await $.clock.now()
  const nowSec = Math.floor(now / 1000)
  // Oldest items first, so the numbers reach the app in their order.
  const order = [...r.accounts.values()].sort((a, b) => (a.items[0]?.seq ?? Infinity) - (b.items[0]?.seq ?? Infinity))
  for (const acc of order) {
    if (acc.muted || acc.restUntil > now) continue
    freeze(r, acc, nowSec)
    if (acc.items.length === 0) continue
    if (!(await sendOne($, r, acc, timeoutMs))) break
  }
}

// One round at a time: a round still running is the round.
function flush($: EngineInterface, r: Reporter, timeoutMs = FETCH_TIMEOUT_MS): Promise<void> {
  r.inflight ??= sendAll($, r, timeoutMs).catch(() => undefined).finally(() => {
    r.inflight = null
  })
  return r.inflight
}

export async function reporterStart($: EngineInterface, r: Reporter): Promise<void> {
  try {
    r.version = (await $.session.version()).version
  } catch {
    // keep unknown
  }
  r.timer?.cancel()
  r.timer = $.clock.every(SEND_EVERY_MS, () => void flush($, r))
}

export async function reporterTurnStart($: EngineInterface, r: Reporter, e: TurnStartInput): Promise<void> {
  try {
    const who = await identity($, r)
    r.turns.set(e.turnId, who)
    if (r.turns.size > MAX_OPEN_TURNS) r.turns.delete(r.turns.keys().next().value!)
    const sid = await $.session.id()
    if (r.tracked && r.tracked.sid === sid) {
      r.tracked.who = who
      return
    }
    // The first turn of this session in this process: what it cost so far
    // (a resumed or forked session brings its old sum) is the base.
    const { usd } = await reading($)
    r.tracked = usd === null ? null : { sid, last: usd, who }
  } catch {
    // never disturb the session
  }
}

export async function reporterTurnComplete($: EngineInterface, r: Reporter, e: TurnCompleteInput): Promise<void> {
  if (e.agentId) return // a subagent's run: its cost is in the main loop's sum
  try {
    const known = r.turns.has(e.turnId)
    const who = r.turns.get(e.turnId) ?? null
    r.turns.delete(e.turnId)
    const sid = await $.session.id()
    const now = await reading($)
    if (now.usd === null) {
      r.tracked = null
      return
    }
    if (!r.tracked || r.tracked.sid !== sid) {
      r.tracked = { sid, last: now.usd, who }
      return
    }
    const delta = now.usd - r.tracked.last
    r.tracked.last = now.usd // a falling sum is simply the new base
    if (!known || !who || !(delta > 0)) return
    // Reset times only from a turn with responses of its own, never older ones.
    const check = e.usage ? checkFrom(now.rateLimits, Math.floor((await $.clock.now()) / 1000)) : undefined
    book(r, who, delta, check)
  } catch {
    // never disturb the session
  }
}

// The last reading (a /compact or a background agent after the last turn),
// then, when the process ends, one last send within session.end's bound.
export async function reporterEnd(
  $: EngineInterface, r: Reporter, e: SessionEndInput, remainingMs: () => number,
): Promise<void> {
  try {
    const t = r.tracked
    if (t && t.sid === e.sessionId && (await $.session.id()) === e.sessionId) {
      const { usd } = await reading($)
      if (usd !== null) {
        const delta = usd - t.last
        t.last = usd
        if (delta > 0 && t.who) book(r, t.who, delta, undefined)
      }
    }
    if (e.reason === 'clear' || e.reason === 'resume') {
      // The process goes on under another session: the next round sends.
      r.tracked = null
      return
    }
    const left = () => Math.min(FETCH_TIMEOUT_MS, remainingMs() - END_RESERVE_MS)
    if (r.inflight) await within($, r.inflight, left())
    if (!r.inflight && left() > 100) await flush($, r, left())
  } catch {
    // never disturb the exit
  }
}

export async function reporterStatus($: EngineInterface, r: Reporter): Promise<string> {
  let who: Identity | null = null
  try {
    who = await identity($, r)
  } catch {
    // shown as none
  }
  const now = await $.clock.now()
  const lines = [`account-meter: reporter mode, sends the estimated cost to claude-accounts (process ${r.processId})`]
  lines.push(who ? `Account: ${who.email ?? `key ${who.key}`}` : `Account: none, nothing is reported (${r.fileNote})`)
  lines.push(`Last report: ${r.lastReport ? `${iso(r.lastReport.at)}, ${r.lastReport.text}` : 'none yet'}`)
  lines.push(`Last answer: ${r.lastAnswer ? `${iso(r.lastAnswer.at)}, ${r.lastAnswer.text}` : 'none yet'}`)
  if (r.clockHint) lines.push("Note: claude-accounts says this computer's clock is off by more than 5 minutes.")
  const open: string[] = []
  for (const a of r.accounts.values()) {
    const parts: string[] = []
    if (a.items.length) parts.push(`${a.items.length} item(s) waiting for an answer`)
    if (round6(a.draft) > 0) parts.push(`${a.draft.toFixed(4)} USD collected`)
    if (a.restUntil > now) parts.push(`resting until ${iso(a.restUntil)}`)
    if (a.muted) parts.push('silent in this process (mismatch)')
    if (parts.length) open.push(`${a.who.email ?? a.who.key}: ${parts.join(', ')}`)
  }
  lines.push(`Open: ${open.length ? open.join('; ') : 'nothing'}`)
  return lines.join('\n')
}
