import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { buildUsage, childArgv, intervalFrom, nextDelay, parseGetUsage, toPercent } from './box'
import type { Usage } from './box'
import { BOX_ROOT } from './register'

// ---- fixtures (anonymised, derived from real get_usage answers of Claude Code 2.1.301) ----
const LIMITS = [
  { kind: 'session', group: 'session', percent: 74, severity: 'normal', resets_at: '2026-10-16T13:09:59.980878+00:00', scope: null, is_active: true },
  { kind: 'weekly_all', group: 'weekly', percent: 54, severity: 'normal', resets_at: '2026-10-20T23:59:59.980899+00:00', scope: null, is_active: false },
]
const win = (utilization: number | null, resets_at: string | null) => ({ utilization, resets_at, limit_dollars: null, used_dollars: null })

function answer(rateLimits: unknown, extra: Record<string, unknown> = {}): string {
  const body = { session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true, rate_limits: rateLimits, ...extra }
  return [
    '{"type":"system","subtype":"init"}',
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'meter-1', response: body } }),
  ].join('\n') + '\n'
}

const FRESH = answer({
  five_hour: win(74, '2026-10-16T13:09:59.980878+00:00'),
  seven_day: win(54, '2026-10-20T23:59:59.980899+00:00'),
  limits: LIMITS,
  seven_day_breakdown: { as_of: '2026-10-16T10:21:31.034738+00:00', rows: [] },
})
// served from the 60 s snapshot / persisted cache: no limits[], no breakdown
const CACHED = answer({ five_hour: win(70, '2026-10-16T13:09:59.980878+00:00'), seven_day: win(50, '2026-10-20T23:59:59.980899+00:00') })
const SEEDED = answer({ five_hour: win(12.345, null), seven_day: win(1, null), seeded: true })
const NO_RESET = answer({ five_hour: win(5, null), seven_day: win(6, null), limits: LIMITS, seven_day_breakdown: { as_of: '2026-10-16T10:30:00+00:00' } })
const NOT_LOGGED_IN = answer(null, { rate_limits_available: false, subscription_type: null })
const FAILED_FETCH = answer(null)
const ERROR_RESPONSE = JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'meter-1', error: 'Unknown subtype' } }) + '\n'

const CTX = { now: '2026-10-16T10:25:00Z', version: '2.1.301', accountUuid: null, email: null, modelRequests: 0 }
// Tests that simulate ten minutes or more get a longer limit than the kit's
// 5 s: every simulated second runs the plugin's 1-s watch, and on a busy CI
// builder an hour of it took up to 5 s (17.10., box image smoke stage).
const LONG = { timeoutMs: 30_000 }

describe('parser', () => {
  test('fresh answer', () => {
    const p = parseGetUsage(FRESH)
    expect(p).toEqual({
      kind: 'ok', hasLimits: true, asOf: '2026-10-16T10:21:31Z', subscription: 'max',
      fiveHour: { percent: 74, resets_at: '2026-10-16T13:09:59Z' },
      sevenDay: { percent: 54, resets_at: '2026-10-20T23:59:59Z' },
    })
  })

  test('cache answer has no limits[]', () => {
    const p = parseGetUsage(CACHED)
    expect(p.kind === 'ok' && p.hasLimits).toBe(false)
  })

  test('seeded answer keeps decimals and null reset', () => {
    const p = parseGetUsage(SEEDED)
    expect(p.kind === 'ok' && p.fiveHour).toEqual({ percent: 12.35, resets_at: null })
  })

  test('null resets_at', () => {
    const p = parseGetUsage(NO_RESET)
    expect(p.kind === 'ok' && p.sevenDay).toEqual({ percent: 6, resets_at: null })
  })

  test('not logged in', () => expect(parseGetUsage(NOT_LOGGED_IN)).toEqual({ kind: 'login_required' }))
  test('failed fetch is an error', () => expect(parseGetUsage(FAILED_FETCH).kind).toBe('error'))
  test('error response', () => {
    const p = parseGetUsage(ERROR_RESPONSE)
    expect(p.kind === 'error' && p.message).toMatch(/Unknown subtype/)
  })
  test('broken json', () => {
    expect(parseGetUsage('{"type":"control_resp').kind).toBe('error')
    expect(parseGetUsage('').kind).toBe('error')
    expect(parseGetUsage('not json at all\n{broken').kind).toBe('error')
  })
  test('percent is clamped', () => {
    expect(toPercent(140)).toBe(100)
    expect(toPercent(-3)).toBe(0)
    expect(toPercent('7')).toBe(null)
    expect(toPercent(Number.NaN)).toBe(null)
  })
})

describe('usage state', () => {
  const good = buildUsage(parseGetUsage(FRESH), null, CTX)

  test('fresh -> ok', () => {
    expect(good.state).toBe('ok')
    expect(good.fresh).toBe(true)
    expect(good.as_of).toBe('2026-10-16T10:21:31Z')
    expect(good.subscription_type).toBe('max')
  })

  test('cache answer -> stale, previous as_of kept', () => {
    const u = buildUsage(parseGetUsage(CACHED), good, CTX)
    expect(u.state).toBe('stale')
    expect(u.fresh).toBe(false)
    expect(u.as_of).toBe(good.as_of)
  })

  test('limits[] but as_of not newer -> stale', () => {
    expect(buildUsage(parseGetUsage(FRESH), good, CTX).state).toBe('stale')
  })

  test('newer as_of -> ok again', () => {
    expect(buildUsage(parseGetUsage(NO_RESET), good, CTX).state).toBe('ok')
  })

  test('error keeps the last good values', () => {
    const u = buildUsage(parseGetUsage(FAILED_FETCH), good, CTX)
    expect(u.state).toBe('error')
    expect(u.five_hour).toEqual(good.five_hour)
    expect(u.error).toMatch(/unavailable/)
  })

  test('login_required clears values', () => {
    const u = buildUsage(parseGetUsage(NOT_LOGGED_IN), good, CTX)
    expect(u.state).toBe('login_required')
    expect(u.five_hour).toBe(null)
  })
})

describe('backoff', () => {
  test('doubles up to 30 minutes', () => {
    expect([0, 1, 2, 3, 5, 9].map(f => nextDelay(f))).toEqual([300_000, 600_000, 1_200_000, 1_800_000, 1_800_000, 1_800_000])
  })

  test('interval from the box env, 60..3600 s, else 5 min', () => {
    expect(['120', '60', '3600', '59', '3601', 'x', undefined].map(intervalFrom))
      .toEqual([120_000, 60_000, 3_600_000, 300_000, 300_000, 300_000, 300_000])
    expect(nextDelay(0, 3_600_000)).toBe(3_600_000) // never shorter than the interval
  })
})

describe('child command', () => {
  test('no settings, no mcp, no session', () => {
    const a = childArgv('claude', '/tmp/x.log')
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('')
    expect(a).toContain('--strict-mcp-config')
    expect(a).toContain('--no-session-persistence')
    expect(a).not.toContain('--setting-sources=project')
  })
})

// ---- box mode end to end, on a mocked world ----
// ACCOUNT_METER_JITTER_MS=0: no start offset, the first check (10 s) measures.
type Call = { argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }

function world(on: On, o: { creds?: boolean; stdout?: string; exit?: number; fail?: boolean; messages?: string; jitter?: string; interval?: string; elsewhere?: boolean } = {}) {
  const w = {
    runs: [] as Call[],
    files: new Map<string, string>(),
    moved: [] as string[][],
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    stdout: o.stdout ?? FRESH,
    exit: o.exit ?? 0,
    fail: o.fail ?? false,
    creds: o.creds ?? true,
    credStamp: '1000 523',
    refreshOnRun: false,
    // The child rewrites ~/.claude.json (as Claude does), the account unchanged.
    rewriteOnRun: false,
    duringRun: [] as (string | undefined)[], // usage.json as the child sees it
    mtimes: new Map<string, number>(),
  }
  login(w, 'uuid-1', 'a@example.test')
  on('session.start', () => ({ cwd: '/' }) as never)
  const env: Record<string, string> = { HOME: '/home/claude', CLAUDE_CODE_EXECPATH: '/opt/claude', ACCOUNT_METER_JITTER_MS: o.jitter ?? '0' }
  if (o.interval) env.ACCOUNT_METER_INTERVAL_S = o.interval
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('session.version', () => ({ value: { version: '2.1.301' } }) as never)
  // The plugin under test runs from its checkout; resolved, it is the box folder.
  // A file of the world has its own stat.
  on('fs.stat', (_$, e) => {
    if (o.elsewhere) throw new Error(`ENOENT ${e.path}`)
    const text = w.files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file', size: text.length, mtimeMs: w.mtimes.get(e.path) ?? 1, isLink: false } } as never
    if (e.path === ACCOUNT_PATH) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: BOX_ROOT } } as never
  })
  on('command.register', () => ({ value: { command: 'account-meter' } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('.credentials.json') && w.creds }) as never)
  on('fs.read', (_$, e) => {
    const v = w.files.get(e.path)
    if (v === undefined) throw new Error('ENOENT')
    return { value: v } as never
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    w.runs.push({ argv: e.argv, init: e.init as never })
    const [cmd] = e.argv
    if (cmd === 'mv') {
      w.moved.push([...e.argv])
      w.files.set(e.argv[3]!, w.files.get(e.argv[2]!) ?? '')
      w.files.delete(e.argv[2]!)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (cmd === 'stat') {
      return { value: w.creds ? { exitCode: 0, stdout: `${w.credStamp}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'No such file' } } as never
    }
    if (cmd === 'grep') return { value: { exitCode: o.messages ? 0 : 1, stdout: o.messages ?? '0\n', stderr: '' } } as never
    if (cmd === '/opt/claude') {
      w.duringRun.push(w.files.get('/home/claude/.claude-box/usage.json'))
      if (w.fail) throw new Error('timed out')
      if (w.refreshOnRun) w.credStamp = `${Number.parseInt(w.credStamp, 10) + 1} 523`
      if (w.rewriteOnRun) write(w, ACCOUNT_PATH, (w.files.get(ACCOUNT_PATH) ?? '{}').replace(/\}$/, ',"numStartups":7}'))
      return { value: { exitCode: w.exit, stdout: w.stdout, stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.status', (_$, e) => {
    w.status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push((e as { text?: string }).text ?? '')
    return { value: undefined } as never
  })
  return w
}

const USAGE_PATH = '/home/claude/.claude-box/usage.json'
const ACCOUNT_PATH = '/home/claude/.claude.json'

type World = { files: Map<string, string>; mtimes: Map<string, number> }
function write(w: World, path: string, text: string) {
  w.files.set(path, text)
  w.mtimes.set(path, (w.mtimes.get(path) ?? 1) + 1)
}
// ~/.claude.json signed in as `uuid` (a /login, an account switcher).
function login(w: World, uuid: string, email: string) {
  write(w, ACCOUNT_PATH, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }))
}
const usageOf = (w: ReturnType<typeof world>) => JSON.parse(w.files.get(USAGE_PATH) ?? 'null') as Usage

async function start($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: '/home/claude/work' } as never)
}
const childRuns = (w: ReturnType<typeof world>) => w.runs.filter(r => r.argv[0] === '/opt/claude').length

describe('plugin', () => {
  test('measures, writes usage.json atomically, child is isolated', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    expect(w.runs.length).toBe(0)
    await clock.advance(10_000)
    const u = usageOf(w)
    expect(u.state).toBe('ok')
    expect(u.five_hour?.percent).toBe(74)
    expect(u.account_uuid).toBe('uuid-1')
    expect(u.email).toBe('a@example.test')
    expect(u.claude_version).toBe('2.1.301')
    expect(u.model_requests).toBe(0)
    // tmp file + rename, the tmp file is gone afterwards
    expect(w.moved.length).toBe(1)
    expect(w.moved[0]![3]).toBe(USAGE_PATH)
    expect([...w.files.keys()].filter(k => k.includes('.tmp-'))).toEqual([])
    // the child
    const child = w.runs.find(r => r.argv[0] === '/opt/claude')!
    expect(child.argv[child.argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(child.init?.cwd).toMatch(/^\/tmp\/account-meter\/probe$/)
    expect(child.init?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('')
    expect(child.init?.env?.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
    expect(child.init?.stdin).toContain('"subtype":"get_usage"')
    expect(child.init?.stdin).toContain('"skip_behaviors":true')
    // debug log removed
    expect(w.runs.some(r => r.argv[0] === 'rm' && String(r.argv[2]).includes('debug-'))).toBe(true)
    expect(w.status.at(-1)).toMatch(/5h 74%/)
  })

  test('no credentials: login_required, child not started', async ($, on) => {
    const w = world(on, { creds: false })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('login_required')
    expect(w.runs.some(r => r.argv[0] === '/opt/claude')).toBe(false)
  })

  test('counts model requests of the child', async ($, on) => {
    const w = world(on, { messages: '2\n' })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).model_requests).toBe(2)
  })

  test('child failure: error state, then backoff doubles the wait', LONG, async ($, on) => {
    const w = world(on, { fail: true })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('error')
    expect(childRuns(w)).toBe(1)
    await clock.advance(590_000) // 9 min 50 s after: still backing off (10 min)
    expect(childRuns(w)).toBe(1)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(2)
    expect(w.toasts.length).toBe(0) // first state is not a change
  })

  test('recovers and keeps the last good value in between', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('ok')
    w.stdout = FAILED_FETCH
    await clock.advance(300_000)
    const u = usageOf(w)
    expect(u.state).toBe('error')
    expect(u.five_hour?.percent).toBe(74)
    expect(w.toasts.length).toBe(1)
  })

  test('right after a start, empty rate limits are retried instead of reported', async ($, on) => {
    const w = world(on, { stdout: FAILED_FETCH })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    expect(w.files.has(USAGE_PATH)).toBe(false)
    w.stdout = FRESH
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(2)
    expect(usageOf(w).state).toBe('ok')
  })

  test('empty rate limits become an error after the warm-up tries', async ($, on) => {
    const w = world(on, { stdout: FAILED_FETCH })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(70_000) // first try + 6 retries, one per 10 s check
    expect(childRuns(w)).toBe(7)
    expect(usageOf(w).state).toBe('error')
  })

  test('measures every 5 minutes', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(290_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(2)
  })

  test('a single cache answer is measured again after a minute, not reported', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    await clock.advance(10_000)
    const good = usageOf(w)
    w.stdout = CACHED
    await clock.advance(300_000)
    expect(childRuns(w)).toBe(2)
    const held = usageOf(w)
    expect(held.measured_at).toBe(good.measured_at)
    expect(held.state).toBe('ok')
    expect(held.meter?.next_run_at).toBe('2026-10-16T10:31:10Z') // retry one minute after the run
    w.stdout = NO_RESET
    await clock.advance(50_000)
    expect(childRuns(w)).toBe(2)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(3)
    expect(usageOf(w).state).toBe('ok')
    expect(w.toasts.length).toBe(0)
  })

  test('two cache answers in a row are reported as stale', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    await clock.advance(10_000)
    w.stdout = CACHED
    await clock.advance(360_000)
    expect(childRuns(w)).toBe(3)
    const u = usageOf(w)
    expect(u.state).toBe('stale')
    expect(u.five_hour?.percent).toBe(70)
    expect(w.toasts).toEqual(['account-meter: stale'])
  })

  test('the interval comes from ACCOUNT_METER_INTERVAL_S', async ($, on) => {
    const w = world(on, { interval: '120' })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(110_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(2)
  })

  test('usage.json carries the plan; running_since only while the child runs', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    await clock.advance(10_000)
    expect(w.duringRun[0]).toBeUndefined() // nothing to show before the first value
    const u = usageOf(w)
    expect(u.meter).toEqual({ last_run_at: '2026-10-16T10:25:10Z', next_run_at: '2026-10-16T10:30:10Z', running_since: null })
    w.stdout = NO_RESET // newer as_of, so the next answer is a fresh value
    await clock.advance(300_000)
    const seen = JSON.parse(w.duringRun[1] ?? 'null') as Usage
    expect(seen.meter?.running_since).toBe('2026-10-16T10:30:10Z')
    expect(seen.measured_at).toBe(u.measured_at) // the last value stays visible meanwhile
    expect(usageOf(w).meter).toEqual({ last_run_at: '2026-10-16T10:30:10Z', next_run_at: '2026-10-16T10:35:10Z', running_since: null })
  })

  test('a restart clears a running_since left behind', async ($, on) => {
    const w = world(on, { jitter: '60000' })
    w.files.set(USAGE_PATH, JSON.stringify({ schema: 1, state: 'ok', measured_at: '2026-10-16T10:00:00Z',
      meter: { last_run_at: '2026-10-16T10:00:00Z', next_run_at: '2026-10-16T10:05:00Z', running_since: '2026-10-16T10:05:00Z' } }))
    mock.clock(on, { now: Date.parse('2026-10-16T10:20:00Z') })
    await start($)
    expect(usageOf(w).meter?.running_since).toBe(null)
    expect(usageOf(w).measured_at).toBe('2026-10-16T10:00:00Z')
  })

  test('a new login is measured within 10 s, not at the next interval', async ($, on) => {
    const w = world(on, { creds: false })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('login_required')
    w.creds = true
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    expect(usageOf(w).state).toBe('ok')
  })

  test("a token refresh by the measuring child does not trigger another run", async ($, on) => {
    const w = world(on)
    w.refreshOnRun = true
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(40_000)
    expect(childRuns(w)).toBe(1)
  })

  test('after a restart without a good value, the first check measures despite the offset', async ($, on) => {
    const w = world(on, { jitter: '60000' })
    w.files.set(USAGE_PATH, JSON.stringify({ schema: 1, state: 'login_required', measured_at: '2026-10-16T10:00:00Z' }))
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    expect(usageOf(w).state).toBe('ok')
  })

  test('a logout is reported within 10 s', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('ok')
    w.creds = false
    await clock.advance(10_000)
    expect(usageOf(w).state).toBe('login_required')
  })

  test('/clear and an in-process resume keep the meter running (no session.start follows)', LONG, async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await clock.advance(300_000)
    expect(childRuns(w)).toBe(2)
    await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } } as never)
    await clock.advance(300_000)
    expect(childRuns(w)).toBe(3)
  })

  test('the end of the process stops the meter', LONG, async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
    await clock.advance(600_000)
    expect(childRuns(w)).toBe(1)
  })

  test('/account-meter status shows the box mode and the last value', async ($, on) => {
    world(on)
    const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:25:00Z') })
    await start($)
    await clock.advance(10_000)
    const r = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(r.text).toMatch(/box mode/)
    expect(r.text).toMatch(/2026-10-16T10:25:10Z, 5h 74% 7d 54% \(a@example\.test\)/)
  })

  test('a switch to another account is measured within 10 s, not at the next interval', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    expect(usageOf(w).account_uuid).toBe('uuid-1')
    w.stdout = NO_RESET // the new account's answer, newer as_of
    login(w, 'uuid-2', 'b@example.test') // the credentials file keeps its stamp
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(2)
    expect(usageOf(w).account_uuid).toBe('uuid-2')
    expect(usageOf(w).email).toBe('b@example.test')
    await clock.advance(60_000)
    expect(childRuns(w)).toBe(2) // then the interval again
  })

  test('a restart on another account than usage.json names measures at the first check, without the offset', async ($, on) => {
    const w = world(on, { jitter: '3600000' })
    w.files.set(USAGE_PATH, JSON.stringify({ schema: 1, state: 'ok', measured_at: '2026-10-16T10:00:00Z', account_uuid: 'uuid-0' }))
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    expect(usageOf(w).account_uuid).toBe('uuid-1')
  })

  test("the measuring child rewriting ~/.claude.json does not trigger another run", async ($, on) => {
    const w = world(on)
    w.rewriteOnRun = true
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
    await clock.advance(40_000)
    expect(childRuns(w)).toBe(1)
  })

  test('~/.claude.json half written or gone for a moment is no switch', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(10_000)
    write(w, ACCOUNT_PATH, '{"oauthAccount":{"accountUu')
    await clock.advance(10_000)
    w.files.delete(ACCOUNT_PATH)
    await clock.advance(10_000)
    login(w, 'uuid-1', 'a@example.test')
    await clock.advance(10_000)
    expect(childRuns(w)).toBe(1)
  })

  test('outside the box folder the box meter never starts', LONG, async ($, on) => {
    const w = world(on, { elsewhere: true })
    const clock = mock.clock(on, { now: 0 })
    await start($)
    await clock.advance(600_000)
    expect(w.runs.length).toBe(0)
    expect(w.files.has(USAGE_PATH)).toBe(false)
  })
})
