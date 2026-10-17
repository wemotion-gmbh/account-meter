// account-meter, box mode: measures the 5h / 7d usage of the logged-in account
// via the SDK control_request `get_usage` (no model request) and writes
// ~/.claude-box/usage.json. Only active when the plugin runs from
// /opt/claude-box/plugin (register.ts).
import type { EngineInterface, SessionEndInput } from 'claude-code'

// The cadence comes from the app (env MEASURE_INTERVAL -> box env
// ACCOUNT_METER_INTERVAL_S, 60..3600 s); this is the default without it.
const DEFAULT_INTERVAL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
// Spreads the first measurement so a rollout does not start every box's
// child at once.
const JITTER_MS = 60_000
// How often the (cheap) credentials check runs: a new login, a token refresh
// or a logout is measured right away instead of at the next interval.
const CHECK_MS = 10_000
// Right after Claude starts, get_usage can answer without rate limits (seen
// after every box restart). Until the first good value of this process that
// answer is retried at the next check instead of being reported as an error.
const WARMUP_TRIES = 6
// A single cache answer is normal (the endpoint refreshes about once a
// minute): it is measured again after STALE_RETRY_MS and only reported when
// that answer comes from the cache too.
const STALE_RETRY_MS = 60_000
export const EMPTY_RATE_LIMITS = 'usage endpoint unavailable (rate_limits empty)'
const CHILD_TIMEOUT_MS = 60_000
const WORK_ROOT = '/tmp/account-meter'
const CHILD_MARKER = 'CLAUDE_ACCOUNT_METER_CHILD'
const REQUEST_ID = 'meter-1'

type Window = { percent: number; resets_at: string | null }
// The meter's plan, for the ring in the overview: end of the last run, the
// planned next run, and since when a run is going on (null = none).
type Meter = { last_run_at: string | null; next_run_at: string | null; running_since: string | null }
type State = 'ok' | 'login_required' | 'stale' | 'error'
export type Usage = {
  schema: 1
  measured_at: string
  as_of: string | null
  fresh: boolean
  state: State
  error: string | null
  five_hour: Window | null
  seven_day: Window | null
  subscription_type: string | null
  account_uuid: string | null
  email: string | null
  model_requests: number
  claude_version: string
  meter?: Meter
}

export type Parsed =
  | {
      kind: 'ok'
      fiveHour: Window | null
      sevenDay: Window | null
      hasLimits: boolean
      asOf: string | null
      subscription: string | null
    }
  | { kind: 'login_required' }
  | { kind: 'error'; message: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// RFC3339 UTC without fractional seconds; null for anything unparseable.
export function toUtc(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// `utilization` of get_usage is already a percentage (verified: 74 == the /usage screen).
// Normalised to a finite number within 0..100, rounded to 2 decimals.
export function toPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(Math.min(100, Math.max(0, v)) * 100) / 100
}

function toWindow(v: unknown): Window | null {
  if (!isObj(v)) return null
  const percent = toPercent(v.utilization)
  return percent === null ? null : { percent, resets_at: toUtc(v.resets_at) }
}

export function parseGetUsage(stdout: string): Parsed {
  let response: Record<string, unknown> | null = null
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let msg: unknown
    try {
      msg = JSON.parse(s)
    } catch {
      continue
    }
    if (isObj(msg) && msg.type === 'control_response' && isObj(msg.response)) response = msg.response
  }
  if (!response) return { kind: 'error', message: 'no control_response in output' }
  if (response.subtype === 'error') {
    return { kind: 'error', message: `get_usage failed: ${String(response.error ?? 'unknown').slice(0, 160)}` }
  }
  const body = response.response
  if (!isObj(body)) return { kind: 'error', message: 'malformed control_response' }
  if (body.rate_limits_available === false) return { kind: 'login_required' }
  const rl = body.rate_limits
  if (!isObj(rl)) return { kind: 'error', message: EMPTY_RATE_LIMITS }
  const fiveHour = toWindow(rl.five_hour)
  const sevenDay = toWindow(rl.seven_day)
  if (!fiveHour && !sevenDay) return { kind: 'error', message: 'rate_limits without five_hour/seven_day' }
  const breakdown = isObj(rl.seven_day_breakdown) ? rl.seven_day_breakdown : null
  return {
    kind: 'ok',
    fiveHour,
    sevenDay,
    hasLimits: Array.isArray(rl.limits) && rl.limits.length > 0,
    asOf: toUtc(breakdown?.as_of),
    subscription: typeof body.subscription_type === 'string' ? body.subscription_type : null,
  }
}

export function intervalFrom(value: string | undefined): number {
  const s = Number.parseInt(value ?? '', 10)
  return Number.isFinite(s) && s >= 60 && s <= 3600 ? s * 1000 : DEFAULT_INTERVAL_MS
}

// Next wait: the interval normally, doubling per consecutive failure, at most
// 30 min (or the interval, if that is longer).
export function nextDelay(failures: number, interval = DEFAULT_INTERVAL_MS): number {
  return Math.min(interval * 2 ** Math.max(0, failures), Math.max(MAX_BACKOFF_MS, interval))
}

const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

type Ctx = {
  now: string
  version: string
  accountUuid: string | null
  email: string | null
  modelRequests: number
}

// Fresh = the answer carries limits[] (a live endpoint reply) and its as_of is newer than the last
// value; a cache/seeded answer has no limits[] and keeps the previous as_of.
export function buildUsage(parsed: Parsed, prev: Usage | null, ctx: Ctx): Usage {
  const base = {
    schema: 1 as const,
    measured_at: ctx.now,
    account_uuid: ctx.accountUuid,
    email: ctx.email,
    model_requests: ctx.modelRequests,
    claude_version: ctx.version,
  }
  if (parsed.kind === 'login_required') {
    return {
      ...base, as_of: null, fresh: false, state: 'login_required', error: null,
      five_hour: null, seven_day: null, subscription_type: null,
    }
  }
  if (parsed.kind === 'error') {
    // the last good values stay, the state is honest
    return {
      ...base, as_of: prev?.as_of ?? null, fresh: false, state: 'error', error: parsed.message,
      five_hour: prev?.five_hour ?? null, seven_day: prev?.seven_day ?? null,
      subscription_type: prev?.subscription_type ?? null,
    }
  }
  const newer = parsed.asOf === null || prev?.as_of == null || Date.parse(parsed.asOf) > Date.parse(prev.as_of)
  const fresh = parsed.hasLimits && newer
  return {
    ...base,
    as_of: parsed.asOf ?? prev?.as_of ?? null,
    fresh,
    state: fresh ? 'ok' : 'stale',
    error: fresh ? null : 'answer came from the cache, not from the usage endpoint',
    five_hour: parsed.fiveHour,
    seven_day: parsed.sevenDay,
    subscription_type: parsed.subscription,
  }
}

export function childArgv(execPath: string, debugFile: string): string[] {
  return [
    execPath, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--debug-file', debugFile,
  ]
}

export const REQUEST = JSON.stringify({
  type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true },
}) + '\n'

function statusLine(u: Usage): string {
  if (u.state === 'login_required') return 'login required'
  const w = (x: Window | null) => (x ? `${Math.round(x.percent)}%` : '?')
  return `5h ${w(u.five_hour)} 7d ${w(u.seven_day)}${u.state === 'ok' ? '' : ` (${u.state})`}`
}

// The box meter of one plugin load (register.ts): boxStart at session.start
// (after next), boxEnd at session.end, boxStatus for /account-meter status.
export type Box = { stop: (() => void) | null; shown: Usage | null; every: number }

export function newBox(): Box {
  return { stop: null, shown: null, every: DEFAULT_INTERVAL_MS }
}

export async function boxStart($: EngineInterface, box: Box): Promise<void> {
  // The measuring child must never run the meter itself.
  if ((await $.env.get('CLAUDE_ACCOUNT_METER_CHILD')) !== undefined) return

  const home = (await $.env.get('HOME')) ?? '/home/claude'
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const usagePath = `${home}/.claude-box/usage.json`
  const interval = intervalFrom(await $.env.get('ACCOUNT_METER_INTERVAL_S'))
  box.every = interval
  let failures = 0
  let last: Usage | null = null
  let lastState: State | null = null
  let busy = false
  let stopped = false
  let hadOk = false
  let warmups = 0
  let staleHeld = false

  try {
    const prev = JSON.parse(await $.fs.read(usagePath)) as Usage
    if (isObj(prev) && prev.schema === 1) last = prev
  } catch {
    // no previous value
  }

  const writeAtomic = async (u: Usage) => {
    const tmp = `${usagePath}.tmp-${Math.random().toString(36).slice(2, 10)}`
    await $.fs.write(tmp, JSON.stringify(u) + '\n')
    const mv = await $.process.run(['mv', '-f', tmp, usagePath])
    if (mv.exitCode !== 0) {
      await $.process.run(['rm', '-f', tmp])
      throw new Error('rename failed')
    }
  }

  const identity = async () => {
    try {
      const cfg = JSON.parse(await $.fs.read(`${home}/.claude.json`)) as Record<string, unknown>
      const acc = isObj(cfg.oauthAccount) ? cfg.oauthAccount : {}
      return {
        accountUuid: typeof acc.accountUuid === 'string' ? acc.accountUuid : null,
        email: typeof acc.emailAddress === 'string' ? acc.emailAddress : null,
      }
    } catch {
      return { accountUuid: null, email: null }
    }
  }

  const measure = async (): Promise<Usage> => {
    const nowMs = await $.clock.now()
    const now = isoOf(nowMs)
    let version = 'unknown'
    try {
      version = (await $.session.version()).version
    } catch {
      // keep unknown
    }
    const who = await identity()
    const ctxBase = { now, version, ...who, modelRequests: 0 }
    if (!(await $.fs.exists(`${configDir}/.credentials.json`))) {
      return buildUsage({ kind: 'login_required' }, last, ctxBase)
    }
    const execPath = (await $.env.get('CLAUDE_CODE_EXECPATH')) || 'claude'
    const cwd = `${WORK_ROOT}/probe`
    const debugFile = `${WORK_ROOT}/debug-${nowMs}.log`
    let parsed: Parsed
    let modelRequests = 0
    try {
      await $.process.run(['mkdir', '-p', cwd])
      const run = await $.process.run(childArgv(execPath, debugFile), {
        stdin: REQUEST,
        cwd,
        timeoutMs: CHILD_TIMEOUT_MS,
        env: {
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
          CLAUDE_CODE_PLUGIN_DIRS: '',
          [CHILD_MARKER]: '1',
        },
      })
      parsed = run.exitCode === 0 || run.stdout.includes('control_response')
        ? parseGetUsage(run.stdout)
        : { kind: 'error', message: `claude exited with code ${run.exitCode}` }
      const grep = await $.process.run(['grep', '-c', '-E', '/v1/messages([?" ]|$)', debugFile])
      modelRequests = grep.exitCode === 0 ? Number.parseInt(grep.stdout.trim(), 10) || 0 : 0
    } catch (err) {
      parsed = { kind: 'error', message: `measuring failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` }
    } finally {
      try {
        await $.process.run(['rm', '-f', debugFile])
      } catch {
        // best effort
      }
    }
    return buildUsage(parsed, last, { ...ctxBase, modelRequests })
  }

  // Returns the wait until the next measurement when it is not the normal one.
  const tick = async (): Promise<number | null> => {
    if (busy || stopped) return null
    busy = true
    try {
      const u = await measure()
      if (!hadOk && u.state === 'error' && u.error === EMPTY_RATE_LIMITS && warmups < WARMUP_TRIES) {
        warmups++
        return 0
      }
      if (u.state === 'stale' && last?.state !== 'stale' && !staleHeld) {
        staleHeld = true
        return STALE_RETRY_MS
      }
      staleHeld = false
      if (u.state === 'ok') hadOk = true
      last = u // written by publish() together with the next plan
      box.shown = u
      failures = u.state === 'error' || u.state === 'stale' ? failures + 1 : 0
      $.ui.status(statusLine(u))
      if (lastState !== null && u.state !== lastState && u.state !== 'ok') {
        $.ui.toast(`account-meter: ${u.state}`)
      }
      lastState = u.state
      return null
    } finally {
      busy = false
    }
  }

  // mtime + size of .credentials.json, null when missing. One stat process
  // per check; the file itself is never read here.
  const credentialsStamp = async (): Promise<string | null> => {
    const r = await $.process.run(['stat', '-c', '%Y %s', `${configDir}/.credentials.json`])
    return r.exitCode === 0 ? r.stdout.trim() : null
  }

  // ACCOUNT_METER_JITTER_MS only exists for tests (0 = measure at the first check).
  const jitterEnv = Number.parseInt((await $.env.get('ACCOUNT_METER_JITTER_MS')) ?? '', 10)
  const jitterMax = Number.isFinite(jitterEnv) && jitterEnv >= 0 ? jitterEnv : JITTER_MS
  // Only a box that already measured fine waits: after a login (Claude is
  // restarted then) or without any value yet, the first check measures.
  const jitter = last?.state === 'ok' ? Math.floor(Math.random() * jitterMax) : 0
  let nextMeasureAt = (await $.clock.now()) + jitter
  let lastRunAt: string | null = null
  // Writes the last value with the plan; nothing before the first value.
  const publish = async (runningSince: string | null) => {
    if (!last) return
    try {
      await writeAtomic({
        ...last,
        meter: { last_run_at: lastRunAt, next_run_at: nextMeasureAt > 0 ? isoOf(nextMeasureAt) : null, running_since: runningSince },
      })
    } catch {
      // keep the in-memory value; the next cycle tries again
    }
  }
  // Also clears a running_since left behind by a previous process.
  await publish(null)
  let credStamp: string | null | undefined
  const check = async () => {
    if (busy || stopped) return
    try {
      const stamp = await credentialsStamp()
      if (credStamp !== undefined && stamp !== credStamp) nextMeasureAt = 0 // login, refresh or logout
      credStamp = stamp
    } catch {
      // stat failed: keep the interval
    }
    const startedAt = await $.clock.now()
    if (startedAt < nextMeasureAt) return
    await publish(isoOf(startedAt))
    const wait = await tick()
    const done = await $.clock.now()
    nextMeasureAt = done + (wait ?? nextDelay(failures, interval))
    lastRunAt = isoOf(done)
    await publish(null)
    try {
      // A refresh written by our own measuring child must not trigger
      // another measurement.
      credStamp = await credentialsStamp()
    } catch {
      // next check sets it
    }
  }

  const schedule = () => {
    if (stopped) return
    const timer = $.clock.after(CHECK_MS, () => {
      void check().finally(schedule)
    })
    box.stop = () => {
      stopped = true
      timer.cancel()
    }
  }

  box.stop?.()
  schedule()
}

// /clear and an in-process resume end the session, not the process: no
// session.start follows, so the timer must go on.
export function boxEnd(box: Box, reason: SessionEndInput['reason']): void {
  if (reason !== 'clear' && reason !== 'resume') box.stop?.()
}

export function boxStatus(box: Box): string {
  const head = `account-meter: box mode, measures 5h / 7d every ${Math.round(box.every / 60_000)} min into ~/.claude-box/usage.json`
  const u = box.shown
  if (!u) return `${head}\nLast measurement: none yet`
  return `${head}\nLast measurement: ${u.measured_at}, ${statusLine(u)}${u.email ? ` (${u.email})` : ''}`
}
