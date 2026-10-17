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
// How long a hook waits for the reporter: a reading outside a turn's end,
// and a turn's own start and end.
const CHECKPOINT_MS = 2_000
// How often the account file is looked at: a `stat`, read only when it
// changed; a switch counts from at most this long after it (Alex: every
// second is enough).
export const WATCH_MS = 1_000
const HOOK_MS = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Identity = { uuid: string; key: string; email: string | null }
export type Check = { five_hour_resets_at?: number; seven_day_resets_at?: number }
export type Item = {
  readonly seq: number
  readonly session: string
  readonly from_usd: number
  readonly to_usd: number
  readonly check?: Readonly<Check>
}
// A stretch of one session's running sum, booked to one account.
type Span = { session: string; from: number; to: number }

// One account of this process: what is collected but not sent yet (`draft`,
// the last span may still grow) and the items sent at least once (fixed from
// then on).
type Account = {
  who: Identity
  draft: Span[]
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
  return JSON.stringify({ schema: 2, process: processId, claude_version: version, items })
}

// The session as the app sees it. Two copies of this plugin in one process see
// the same session and the same sums, so they send the same ranges and the app
// books them once. `epoch` counts falls of the sum (normally 0), so a sum that
// starts over does not land on ranges already booked.
export function sessionKey(sessionId: string, epoch: number): string {
  return sha256Hex(`account-meter:${sessionId}:${epoch}`).slice(0, 16)
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
  // The session whose cost this process follows: the last sum seen and its
  // key for the app.
  tracked: Tracked | null
  // Main-loop turns seen starting in this process.
  turns: Set<string>
  // Who the cost since the last reading belongs to; undefined: not looked yet.
  who: Identity | null | undefined
  watch: { cancel: () => void } | null
  // Readings one at a time: one that overtook another would look like a fall.
  chain: Promise<unknown>
  accounts: Map<string, Account>
  timer: { cancel: () => void } | null
  inflight: Promise<void> | null
  lastReport: { at: number; text: string } | null
  lastAnswer: { at: number; text: string } | null
  clockHint: boolean
  logged: Set<string>
}

type Tracked = { sid: string; last: number; epoch: number; key: string }

const track = (sid: string, last: number): Tracked => ({ sid, last, epoch: 0, key: sessionKey(sid, 0) })

// The sum is now `usd`: the span since the last reading, or null when it did
// not grow (a fall starts a new epoch from the new sum).
function advance(t: Tracked, usd: number): { from: number; to: number } | null {
  const from = t.last
  t.last = usd
  if (usd < from) {
    t.epoch++
    t.key = sessionKey(t.sid, t.epoch)
  }
  return usd > from ? { from, to: usd } : null
}

export function newReporter(): Reporter {
  return {
    processId: randomHex(8), seq: 0, version: 'unknown',
    file: undefined, stamp: null, current: null, fileNote: 'not read yet',
    tracked: null, turns: new Set(), who: undefined, watch: null, chain: Promise.resolve(), accounts: new Map(),
    timer: null, inflight: null, lastReport: null, lastAnswer: null, clockHint: false, logged: new Set(),
  }
}

function serial<T>(r: Reporter, fn: () => Promise<T>): Promise<T> {
  const run = r.chain.then(fn, fn)
  r.chain = run.catch(() => undefined)
  return run
}

// A hook waits for its reading at most `ms`; a reading that hangs stalls only
// the reporter, never the session.
function guarded($: EngineInterface, r: Reporter, fn: () => Promise<void>, ms = CHECKPOINT_MS): Promise<void> {
  return within($, serial(r, fn), ms).then(() => undefined, () => undefined)
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
// read again only when it changed (a /login rewrites it, as does much else).
// A file that cannot be stat'ed or read for a moment keeps the account known
// so far (looked at every second, a half-written file must not look like a
// logout); only a file that reads without an account means none.
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
    r.fileNote = `${path} not found`
    return r.current
  }
  if (s === r.stamp) return r.current
  r.stamp = null
  const before = r.current
  try {
    const cfg: unknown = JSON.parse(await $.fs.read(path))
    const acc = isObj(cfg) && isObj(cfg.oauthAccount) ? cfg.oauthAccount : null
    const uuid = normalizeUuid(acc?.accountUuid)
    const email = typeof acc?.emailAddress === 'string' ? acc.emailAddress : null
    r.current = uuid ? { uuid, key: before?.uuid === uuid ? before.key : reportKey(uuid), email } : null
    r.fileNote = uuid ? path : `no oauthAccount.accountUuid in ${path}`
    r.stamp = s
  } catch {
    r.fileNote = `${path} unreadable, read again in a second`
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

function book(r: Reporter, who: Identity, key: string, span: { from: number; to: number }, check: Check | undefined): void {
  let acc = r.accounts.get(who.uuid)
  if (!acc) {
    acc = { who, draft: [], check: undefined, items: [], restUntil: 0, muted: false, maxItems: MAX_ITEMS }
    r.accounts.set(who.uuid, acc)
  }
  acc.who = who
  if (acc.muted) return
  const last = acc.draft[acc.draft.length - 1]
  if (last && last.session === key && last.to === span.from) last.to = span.to
  else acc.draft.push({ session: key, from: span.from, to: span.to })
  if (check) acc.check = check
}

// What the session cost since the last reading goes to `who`. Callers hold
// the chain.
async function growth($: EngineInterface, r: Reporter, who: Identity | null): Promise<void> {
  const t = r.tracked
  if (!t || (await $.session.id()) !== t.sid) return
  const { usd } = await reading($)
  if (usd === null || r.tracked !== t) return
  const span = advance(t, usd)
  if (span && who) book(r, who, t.key, span, undefined)
}

// Who works now. Every Claude Code window on this config folder shares the
// account file, and a /login in any of them switches them all, also in the
// middle of a turn. So on a change, what grew up to now is the old
// account's, from now on the new one's. Callers hold the chain.
async function observe($: EngineInterface, r: Reporter): Promise<Identity | null> {
  const now = await identity($, r)
  if (r.who !== undefined && (r.who?.uuid ?? null) !== (now?.uuid ?? null)) await growth($, r, r.who)
  r.who = now
  return now
}

// What grew since the last reading, outside a turn's end: a background agent,
// a /compact, the minute tick, the moment before /login. Callers hold the
// chain.
async function checkpointNow($: EngineInterface, r: Reporter): Promise<void> {
  await growth($, r, await observe($, r))
}

const drafted = (acc: Account) => acc.draft.reduce((sum, s) => sum + (round6(s.to) - round6(s.from)), 0)

// Turns what was collected into items; an item never changes after this.
// Ranges are rounded to the micro dollar at both ends, so spans that touch
// stay touching.
function freeze(r: Reporter, acc: Account, nowSec: number): void {
  while (acc.items.length < acc.maxItems && acc.draft.length > 0) {
    const s = acc.draft[0]!
    const from = round6(s.from)
    const end = round6(s.to)
    if (!(end > from)) {
      acc.draft.shift()
      continue
    }
    const to = Math.min(end, round6(from + MAX_ITEM_USD))
    if (to < end) s.from = to
    else acc.draft.shift()
    const check = future(acc.check, nowSec)
    const seq = ++r.seq
    const item = { seq, session: s.session, from_usd: from, to_usd: to }
    acc.items.push(Object.freeze(check ? { ...item, check: Object.freeze(check) } : item))
  }
  if (acc.draft.length === 0) acc.check = undefined
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
  const usd = batch.reduce((sum, i) => sum + (i.to_usd - i.from_usd), 0)
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
      // The reset times say another account worked: drop what was collected
      // and stay silent for this account for a while.
      acc.muted = true
      acc.restUntil = sentAt + REST_MS
      acc.items = []
      acc.draft = []
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
    if (acc.muted && acc.restUntil <= now) acc.muted = false
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
  r.timer = $.clock.every(SEND_EVERY_MS, () => void tick($, r))
  // A /login in another window shows only in the account file (the engine has
  // no file watch): looked at every second, it draws the line close to it.
  r.watch?.cancel()
  r.watch = $.clock.every(WATCH_MS, () => void guarded($, r, async () => void (await observe($, r))))
}

// Every minute: what grew meanwhile (a background agent while nobody types),
// then a round.
async function tick($: EngineInterface, r: Reporter): Promise<void> {
  await guarded($, r, () => checkpointNow($, r))
  await flush($, r)
}

// Right before /login or /logout: what grew since the last reading still
// counts for the account logged in now, and goes out at once (not awaited,
// the command runs on).
export async function reporterBeforeLogin($: EngineInterface, r: Reporter): Promise<void> {
  await guarded($, r, () => checkpointNow($, r))
  void flush($, r)
}

export function reporterTurnStart($: EngineInterface, r: Reporter, e: TurnStartInput): Promise<void> {
  return guarded($, r, () => turnStart($, r, e), HOOK_MS)
}

async function turnStart($: EngineInterface, r: Reporter, e: TurnStartInput): Promise<void> {
  try {
    await observe($, r)
    r.turns.add(e.turnId)
    if (r.turns.size > MAX_OPEN_TURNS) r.turns.delete(r.turns.values().next().value!)
    const sid = await $.session.id()
    if (r.tracked && r.tracked.sid === sid) return
    // The first turn of this session in this process: what it cost so far
    // (a resumed or forked session brings its old sum) is the base.
    const { usd } = await reading($)
    r.tracked = usd === null ? null : track(sid, usd)
  } catch {
    // never disturb the session
  }
}

export function reporterTurnComplete($: EngineInterface, r: Reporter, e: TurnCompleteInput): Promise<void> {
  // A subagent's run (also one in the background, after the main turn): its
  // cost is in the session's sum, read now.
  if (e.agentId) return guarded($, r, () => checkpointNow($, r))
  return guarded($, r, () => turnComplete($, r, e), HOOK_MS)
}

async function turnComplete($: EngineInterface, r: Reporter, e: TurnCompleteInput): Promise<void> {
  try {
    const known = r.turns.delete(e.turnId)
    // A switch not noticed yet: what grew before it is the old account's.
    const who = await observe($, r)
    const sid = await $.session.id()
    const now = await reading($)
    if (now.usd === null) {
      r.tracked = null
      return
    }
    if (!r.tracked || r.tracked.sid !== sid) {
      r.tracked = track(sid, now.usd)
      return
    }
    const span = advance(r.tracked, now.usd)
    if (!known || !who || !span) return
    // Reset times only from a turn with responses of its own, never older ones.
    const check = e.usage ? checkFrom(now.rateLimits, Math.floor((await $.clock.now()) / 1000)) : undefined
    book(r, who, r.tracked.key, span, check)
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
    if (r.tracked?.sid === e.sessionId) {
      await guarded($, r, () => checkpointNow($, r), Math.min(CHECKPOINT_MS, remainingMs() - END_RESERVE_MS))
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
    const usd = drafted(a)
    if (round6(usd) > 0) parts.push(`${usd.toFixed(4)} USD collected`)
    if (a.restUntil > now && !a.muted) parts.push(`resting until ${iso(a.restUntil)}`)
    if (a.muted) parts.push(`silent until ${iso(a.restUntil)} (mismatch)`)
    if (parts.length) open.push(`${a.who.email ?? a.who.key}: ${parts.join(', ')}`)
  }
  lines.push(`Open: ${open.length ? open.join('; ') : 'nothing'}`)
  return lines.join('\n')
}
