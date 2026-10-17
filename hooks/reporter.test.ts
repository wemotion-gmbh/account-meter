import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { hmacSha256Hex } from './crypto'
import { checkFrom, classify, homeFromRoot, MAX_ITEMS, normalizeUuid, REPORT_URL, reportKey, sessionKey, WATCH_MS } from './reporter'

const T0 = Date.parse('2026-10-17T08:00:00Z')
const MIN = 60_000
const FILE = '/cfg/.claude.json'
const A = '0f8fad5b-d9cb-469f-a165-70867728950e'
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const FIVE = '2026-10-17T10:00:00Z' // ahead of T0
const SEVEN = '2026-10-20T00:00:00Z'
const sec = (iso: string) => Date.parse(iso) / 1000
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, model: 'claude-test' }
// Tests that simulate ten minutes or more get a longer limit than the kit's
// 5 s: every simulated second runs the plugin's 1-s watch, and on a busy CI
// builder an hour of it took up to 5 s (17.10., box image smoke stage).
const LONG = { timeoutMs: 30_000 }

// ---- pure parts ----

describe('identity and cross-check helpers', () => {
  test('uuid: trimmed, lower case, canonical only', () => {
    expect(normalizeUuid(` ${A.toUpperCase()}\n`)).toBe(A)
    expect(normalizeUuid('0f8fad5bd9cb469fa16570867728950e')).toBe(null)
    expect(normalizeUuid(42)).toBe(null)
    expect(normalizeUuid(undefined)).toBe(null)
  })

  test('home folder from the plugin folder', () => {
    expect(homeFromRoot('/Users/alex/.claude/plugins/cache/wemotion/account-meter/1.0.0')).toBe('/Users/alex')
    expect(homeFromRoot('/home/dev/.claude/plugins/cache/wemotion/account-meter/1.0.0')).toBe('/home/dev')
    expect(homeFromRoot('C:\\Users\\Alex\\.claude\\plugins\\cache\\wemotion\\account-meter\\1.0.0')).toBe('C:\\Users\\Alex')
    expect(homeFromRoot('/Users/alex/Projekte/Aufgaben/x/account-meter')).toBe('/Users/alex')
    expect(homeFromRoot('/root/plugins/account-meter')).toBe('/root')
    expect(homeFromRoot('/opt/somewhere/account-meter')).toBe(null)
  })

  test('cross-check: five_hour / seven_day reset times still ahead, nothing else', () => {
    const now = sec('2026-10-17T08:00:00Z')
    expect(checkFrom([
      { kind: 'five_hour', percentUsed: 10, resetsAt: FIVE },
      { kind: 'seven_day', percentUsed: 20, resetsAt: SEVEN },
      { kind: 'spend_limit', percentUsed: 120, resetsAt: SEVEN },
    ], now)).toEqual({ five_hour_resets_at: sec(FIVE), seven_day_resets_at: sec(SEVEN) })
    expect(checkFrom([{ kind: 'five_hour', percentUsed: 1, resetsAt: '2026-10-17T07:59:59Z' }, { kind: 'seven_day', percentUsed: 2 }], now))
      .toBe(undefined)
    expect(checkFrom([], now)).toBe(undefined)
  })
})

describe('answers (CONTRACT-2.md table)', () => {
  const j = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) })
  test('200 with a receipt settles ok, duplicate and rejected, nothing else', () => {
    expect(classify(j(200, { results: [
      { seq: 7, status: 'ok' }, { seq: 8, status: 'duplicate' }, { seq: 9, status: 'rejected', reason: 'budget' },
      { seq: 10, status: 'later' }, { status: 'ok' },
    ] }))).toEqual({ kind: 'receipt', done: [7, 8, 9], counts: { ok: 1, duplicate: 1, rejected: 1 } })
  })
  test('the named errors', () => {
    expect(classify(j(400, { error: 'invalid' })).kind).toBe('invalid')
    expect(classify(j(401, { error: 'clock' })).kind).toBe('clock')
    expect(classify(j(413, { error: 'too_large' })).kind).toBe('too_large')
    expect(classify({ status: 413, text: 'Request Entity Too Large' }).kind).toBe('too_large')
    expect(classify(j(422, { error: 'unknown_account' })).kind).toBe('unknown_account')
    expect(classify(j(422, { error: 'mismatch' })).kind).toBe('mismatch')
  })
  test('everything else is worth another try', () => {
    for (const r of [
      null, j(200, { ok: true }), { status: 200, text: '<html>login</html>' }, j(400, { error: 'other' }),
      { status: 400, text: 'Bad Request' }, j(401, { error: 'bad_signature' }), j(422, { error: 'new' }),
      j(429, { error: 'rate_limited' }), { status: 302, text: '' }, { status: 404, text: '404 page not found' },
      j(500, { error: 'boom' }), { status: 502, text: 'Bad Gateway' }, { status: 503, text: '' }, j(503, { error: 'unavailable' }),
    ]) expect(classify(r).kind).toBe('retry')
  })
})

// ---- reporter mode end to end, on a mocked world ----
// The plugin runs from its checkout (not /opt/claude-box/plugin), so it is a
// reporter. CLAUDE_CONFIG_DIR=/cfg: the account file is /cfg/.claude.json.

type Init = { method?: string; headers?: Record<string, string>; body?: string; [k: string]: unknown }
type Post = { url: string; init: Init }
type SentItem = { seq: number; session: string; from_usd: number; to_usd: number; check?: Record<string, number> }
const amount = (i: SentItem) => Math.round((i.to_usd - i.from_usd) * 1e6) / 1e6
type Body = { schema: number; process: string; claude_version: string; items: SentItem[] }
type Reply = { status: number; text?: string } | 'throw' | 'timeout'

const receipt = (body: string | undefined, status = 'ok') =>
  JSON.stringify({ results: (JSON.parse(body ?? '{"items":[]}') as Body).items.map(i => ({ seq: i.seq, status })) })

function world(on: On, o: { env?: Record<string, string> } = {}) {
  const w = {
    cost: 0,
    sid: 's1',
    rate: [
      { kind: 'five_hour', percentUsed: 10, resetsAt: FIVE },
      { kind: 'seven_day', percentUsed: 20, resetsAt: SEVEN },
    ] as { kind: string; percentUsed: number; resetsAt?: string }[],
    files: new Map<string, { text: string; mtimeMs: number }>(),
    reads: 0,
    posts: [] as Post[],
    replies: [] as Reply[], // queued answers; when empty: a receipt with every item ok
    envNames: [] as string[],
    runs: 0,
    logs: [] as { text: string; to: string }[],
    toasts: 0,
    statuses: 0,
    // what a core command (/login) does when it runs
    commands: [] as string[],
    onCommand: (_name: string) => {},
  }
  const env = o.env ?? { CLAUDE_CONFIG_DIR: '/cfg' }
  on('env.get', (_$, e) => {
    w.envNames.push(e.name)
    return { value: env[e.name] } as never
  })
  on('session.start', () => ({ cwd: '/' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.id', () => ({ value: w.sid }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: w.rate, cost: { usd: w.cost } } }) as never)
  on('session.version', () => ({ value: { version: '2.1.302' } }) as never)
  on('command.register', () => ({ value: { command: 'account-meter' } }) as never)
  on('command.run', (_$, e) => {
    w.commands.push(e.command)
    w.onCommand(e.command)
    return { text: '' } as never
  })
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } as never
  })
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    w.reads++
    return { value: f.text } as never
  })
  on('http.fetch', async ($, e) => {
    const init = (e.init ?? {}) as Init
    w.posts.push({ url: e.url, init })
    const r = w.replies.shift() ?? { status: 200, text: receipt(init.body) }
    if (r === 'throw') throw new Error('network down')
    if (r === 'timeout') {
      await $.clock.sleep(10 * MIN)
      return { value: { status: 200, ok: true, headers: {}, text: receipt(init.body) } } as never
    }
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: r.text ?? '' } } as never
  })
  on('process.run', () => {
    w.runs++
    throw new Error('no process in reporter mode')
  })
  on('ui.log', (_$, e) => {
    w.logs.push({ text: e.text, to: e.to })
    return { value: undefined } as never
  })
  on('ui.toast', () => {
    w.toasts++
    return { value: undefined } as never
  })
  on('ui.status', () => {
    w.statuses++
    return { value: undefined } as never
  })
  return w
}
type World = ReturnType<typeof world>

let fileClock = 1
function login(w: World, uuid: string | null, email = 'a@example.test') {
  const cfg = uuid === null ? { numStartups: 3, primaryApiKey: 'not-read' } : { numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: email } }
  w.files.set(FILE, { text: JSON.stringify(cfg), mtimeMs: fileClock++ })
}

let turnNo = 0
// One main-loop turn: its cost so far moves to `cost` while it runs.
async function turn($: Engine, w: World, cost: number, o: { usage?: boolean; between?: () => void } = {}) {
  const turnId = `t${++turnNo}`
  await $.turn.start({ text: 'hi', turnId } as never)
  o.between?.()
  w.cost = cost
  await $.turn.complete({
    answer: '', durationMs: 5, isAborted: false, turnId, reason: 'answer', ...(o.usage === false ? {} : { usage: USAGE }),
  } as never)
}

const bodies = (w: World) => w.posts.map(p => JSON.parse(p.init.body ?? '{}') as Body)
const sent = (w: World) => bodies(w).flatMap(b => b.items)
// What the app booked: items answered ok, each seq once.
function booked(w: World): number {
  const seen = new Map<number, number>()
  for (const i of sent(w)) seen.set(i.seq, amount(i))
  return Math.round([...seen.values()].reduce((s, x) => s + x, 0) * 1e6) / 1e6
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
}
const end = (reason: string, sessionId = 's1') => ({ reason, sessionId, resume: { id: sessionId } }) as never

describe('reporter', () => {
  test('reports the cost growth of a turn after a minute, signed as the contract says', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 0.4213)
    await clock.advance(MIN - 1000)
    expect(w.posts.length).toBe(0)
    await clock.advance(1000)
    expect(w.posts.length).toBe(1)
    const p = w.posts[0]!
    expect(p.url).toBe(REPORT_URL)
    expect(p.init.method).toBe('POST')
    expect('auth' in p.init).toBe(false)
    const time = String((T0 + MIN) / 1000)
    const body = p.init.body!
    expect(p.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Report-Key': reportKey(A),
      'X-Report-Time': time,
      'X-Report-Signature': hmacSha256Hex(A, `${time}\n${body}`),
    })
    expect(body.startsWith('{"schema":2,"process":"')).toBe(true)
    const b = JSON.parse(body) as Body
    expect(b.process).toMatch(/^[0-9a-f]{16}$/)
    expect(b.claude_version).toBe('2.1.302')
    expect(b.items).toEqual([{
      seq: 1, session: sessionKey('s1', 0), from_usd: 0, to_usd: 0.4213,
      check: { five_hour_resets_at: sec(FIVE), seven_day_resets_at: sec(SEVEN) },
    }])
    // the uuid itself never goes over the wire
    expect(JSON.stringify(p)).not.toContain(A)
    await clock.advance(5 * MIN)
    expect(w.posts.length).toBe(1) // nothing new, nothing sent
  })

  test('turns within a minute go out together, at most one request per minute', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 0.1)
    await turn($, w, 0.25)
    await clock.advance(20_000)
    await turn($, w, 0.5)
    await clock.advance(40_000)
    expect(w.posts.length).toBe(1)
    expect(sent(w)).toEqual([expect.objectContaining({ seq: 1, from_usd: 0, to_usd: 0.5 })])
  })

  test('resume: the old sum of the session is the base, only new turns count', async ($, on) => {
    const w = world(on)
    login(w, A)
    w.cost = 5 // brought by `claude --resume`
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 5.3)
    await clock.advance(MIN)
    expect(booked(w)).toBe(0.3)
  })

  test('a restore after session.start but before the first turn is part of the base', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    w.cost = 5
    await turn($, w, 5.2)
    await clock.advance(MIN)
    expect(booked(w)).toBe(0.2)
  })

  test('/clear: the next session counts from its own start, never negative, nothing sent at the /clear', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await $.session.end(end('clear'))
    expect(w.posts.length).toBe(0) // the process goes on: the next round sends
    w.sid = 's2'
    w.cost = 0 // the new session's cost starts over
    await turn($, w, 0.5)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(1)
    expect(booked(w)).toBe(1.5)
    expect(sent(w).every(i => amount(i) > 0)).toBe(true)
  })

  test('/resume in the process: the jump to the other session\'s sum is not counted', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await $.session.end(end('resume'))
    w.sid = 'old'
    w.cost = 42
    await turn($, w, 42.5)
    await clock.advance(MIN)
    expect(booked(w)).toBe(1.5)
  })

  test('fork or a second process on the same session counts only its own turns', async ($, on) => {
    const w = world(on)
    login(w, A)
    w.sid = 's1' // -p --resume s1 beside the running session (a fork has its own id, same effect)
    w.cost = 10
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 10.25)
    await clock.advance(MIN)
    expect(booked(w)).toBe(0.25)
  })

  test('two sessions in one process, back and forth', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await $.session.end(end('resume', 's1'))
    w.sid = 's2'
    w.cost = 7
    await turn($, w, 7.5)
    await $.session.end(end('resume', 's2'))
    w.sid = 's1'
    w.cost = 1
    await turn($, w, 1.2)
    await clock.advance(MIN)
    expect(booked(w)).toBe(1.7)
  })

  test('a falling sum without a new session is the new base', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 2)
    await turn($, w, 1.3)
    await turn($, w, 1.8)
    await clock.advance(MIN)
    expect(booked(w)).toBe(2.5)
    // after the fall the session gets a new key, so its ranges cannot land on 0..2
    expect(sent(w).map(i => [i.session, i.from_usd, i.to_usd])).toEqual([
      [sessionKey('s1', 0), 0, 2],
      [sessionKey('s1', 1), 1.3, 1.8],
    ])
  })

  test('the ranges of a session touch, however the turns fall into requests', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 0.1)
    await turn($, w, 0.30000000000000004) // 0.1 + 0.2 in floating point
    await clock.advance(MIN)
    await turn($, w, 0.7)
    await clock.advance(MIN)
    await turn($, w, 0.7000004)
    await turn($, w, 1)
    await clock.advance(MIN)
    const ranges = sent(w).map(i => [i.from_usd, i.to_usd])
    expect(ranges).toEqual([[0, 0.3], [0.3, 0.7], [0.7, 1]])
    expect(new Set(sent(w).map(i => i.session))).toEqual(new Set([sessionKey('s1', 0)]))
  })

  test('a subagent\'s turn and a turn without its own turn.start count nothing on their own', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await $.turn.start({ text: 'hi', turnId: 'main' } as never)
    w.cost = 0.3
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'answer', usage: USAGE } as never)
    w.cost = 0.5
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer', usage: USAGE } as never)
    w.cost = 0.9
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'ghost', reason: 'answer', usage: USAGE } as never)
    await turn($, w, 1)
    await clock.advance(MIN)
    expect(booked(w)).toBe(0.6)
  })

  test('/login in another window during a turn: what grew before it is noticed stays with the old account', async ($, on) => {
    const w = world(on)
    login(w, A, 'a@example.test')
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    // the file changes while a turn runs and is noticed at its end: its cost so far is A's
    await turn($, w, 1.5, { between: () => login(w, B, 'b@example.test') })
    await turn($, w, 2.25) // B from here on
    await clock.advance(MIN)
    expect(w.posts.length).toBe(2)
    expect(w.posts.map(p => p.init.headers?.['X-Report-Key'])).toEqual([reportKey(A), reportKey(B)])
    expect(bodies(w).map(b => b.items.map(i => [i.seq, amount(i)]))).toEqual([[[1, 1.5]], [[2, 0.75]]])
    expect(booked(w)).toBe(2.25) // nothing twice
  })

  test('/login: what grew since the last turn counts for the old account and goes out at once', async ($, on) => {
    const w = world(on)
    login(w, A, 'a@example.test')
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await clock.advance(MIN)
    w.cost = 1.4 // a background agent finished after the turn
    w.onCommand = name => {
      if (name === 'login') login(w, B, 'b@example.test')
    }
    await $.command.run({ command: 'login', args: '' } as never)
    expect(w.commands).toEqual(['login']) // the command itself runs
    await clock.advance(10)
    expect(w.posts.length).toBe(2)
    expect(w.posts[1]!.init.headers?.['X-Report-Key']).toBe(reportKey(A))
    expect(bodies(w)[1]!.items.map(i => [i.from_usd, i.to_usd])).toEqual([[1, 1.4]])
    await turn($, w, 2)
    await clock.advance(MIN)
    expect(w.posts[2]!.init.headers?.['X-Report-Key']).toBe(reportKey(B))
    expect(bodies(w)[2]!.items.map(i => [i.from_usd, i.to_usd])).toEqual([[1.4, 2]])
    expect(booked(w)).toBe(2)
  })

  test('/logout: the last stretch still counts for the account before it', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 0.5)
    w.cost = 0.75
    w.onCommand = name => {
      if (name === 'logout') login(w, null)
    }
    await $.command.run({ command: 'logout', args: '' } as never)
    await clock.advance(10)
    expect(w.posts.map(p => p.init.headers?.['X-Report-Key'])).toEqual([reportKey(A)])
    expect(booked(w)).toBe(0.75)
  })

  test('background agents: read when one ends and every minute, nobody has to type', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await clock.advance(MIN)
    w.cost = 1.2
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'bg', agentId: 'bg1', reason: 'answer', usage: USAGE } as never)
    w.cost = 1.5 // another agent still runs
    await clock.advance(MIN)
    expect(bodies(w)[1]!.items.map(i => [i.from_usd, i.to_usd])).toEqual([[1, 1.5]])
    w.cost = 1.9
    await clock.advance(MIN)
    expect(bodies(w)[2]!.items.map(i => [i.from_usd, i.to_usd])).toEqual([[1.5, 1.9]])
    expect(booked(w)).toBe(1.9)
  })

  test('a /login in another window splits a running turn where the file changes', async ($, on) => {
    const w = world(on)
    login(w, A, 'a@example.test')
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await $.turn.start({ text: 'long', turnId: 'long' } as never)
    w.cost = 1.6
    await clock.advance(5_000)
    login(w, B, 'b@example.test') // /login in another window on this config folder
    await clock.advance(WATCH_MS) // noticed within a second: 1..1.6 was A's
    w.cost = 2
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'long', reason: 'answer', usage: USAGE } as never)
    await clock.advance(MIN)
    const byKey = new Map<string, number>()
    for (const p of w.posts) {
      const k = p.init.headers!['X-Report-Key']!
      for (const i of (JSON.parse(p.init.body!) as Body).items) byKey.set(k, Math.round(((byKey.get(k) ?? 0) + amount(i)) * 1e6) / 1e6)
    }
    expect(byKey).toEqual(new Map([[reportKey(A), 1.6], [reportKey(B), 0.4]]))
    // the turn's reset times go with B, the account its last answer came from
    const last = bodies(w).flatMap(b => b.items).find(i => i.from_usd === 1.6)!
    expect(last.check).toBeDefined()
  })

  test('a switch while nobody types: a background agent\'s cost before it stays with the old account', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.cost = 1.25 // a background agent
    login(w, B, 'b@example.test')
    await clock.advance(WATCH_MS)
    w.cost = 1.5
    await clock.advance(MIN)
    expect(w.posts.map(p => [p.init.headers?.['X-Report-Key'], (JSON.parse(p.init.body!) as Body).items.map(i => [i.from_usd, i.to_usd])])).toEqual([
      [reportKey(A), [[0, 1.25]]],
      [reportKey(B), [[1.25, 1.5]]],
    ])
  })

  test('a half-written or briefly missing account file is no logout', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.files.set(FILE, { text: '{"numStartups": 3, "oauthAcc', mtimeMs: fileClock++ })
    w.cost = 1.2
    await clock.advance(WATCH_MS)
    w.files.delete(FILE)
    await clock.advance(WATCH_MS)
    login(w, A)
    await turn($, w, 1.5)
    await clock.advance(MIN)
    expect(new Set(w.posts.map(p => p.init.headers?.['X-Report-Key']))).toEqual(new Set([reportKey(A)]))
    expect(booked(w)).toBe(1.5)
  })

  test('.claude.json is read again only when it changed', async ($, on) => {
    const w = world(on)
    login(w, A)
    mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 0.1)
    await turn($, w, 0.2)
    await turn($, w, 0.3)
    expect(w.reads).toBe(1)
    login(w, A) // rewritten, same account
    await turn($, w, 0.4)
    expect(w.reads).toBe(2)
  })

  test('without an oauthAccount (API key, gateway) or without the file nothing is reported', async ($, on) => {
    const w = world(on)
    login(w, null)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.files.delete(FILE)
    await turn($, w, 2)
    await clock.advance(3 * MIN)
    expect(w.posts.length).toBe(0)
    const status = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(status.text).toMatch(/Account: none, nothing is reported \(\/cfg\/\.claude\.json not found\)/)
  })

  test('the uuid is normalised before the key is made', async ($, on) => {
    const w = world(on)
    login(w, ` ${A.toUpperCase()} `)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await clock.advance(MIN)
    expect(w.posts[0]?.init.headers?.['X-Report-Key']).toBe(reportKey(A))
  })

  test('the cross-check carries only reset times ahead, and only from turns with responses of their own', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    w.rate = [{ kind: 'five_hour', percentUsed: 10, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-17T07:00:00Z' }]
    await turn($, w, 1)
    await clock.advance(MIN)
    w.rate = [{ kind: 'five_hour', percentUsed: 10, resetsAt: FIVE }]
    await turn($, w, 2, { usage: false }) // an API error: the limits are an older response's
    await clock.advance(MIN)
    expect(sent(w)).toEqual([
      { seq: 1, session: sessionKey('s1', 0), from_usd: 0, to_usd: 1, check: { five_hour_resets_at: sec(FIVE) } },
      { seq: 2, session: sessionKey('s1', 0), from_usd: 1, to_usd: 2 },
    ])
  })

  test('an item never changes once sent; new cost goes into a new item', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 503, text: 'Service Unavailable' })
    await clock.advance(MIN)
    await turn($, w, 1.7)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(2)
    const [first, second] = bodies(w)
    expect(second!.items.length).toBe(2)
    expect(JSON.stringify(second!.items[0])).toBe(JSON.stringify(first!.items[0]))
    expect(second!.items[1]).toEqual(expect.objectContaining({ seq: 2, from_usd: 1, to_usd: 1.7 }))
    expect(w.posts[0]!.init.headers?.['X-Report-Time']).not.toBe(w.posts[1]!.init.headers?.['X-Report-Time'])
    await clock.advance(MIN)
    expect(w.posts.length).toBe(2) // both settled
  })

  test('200: ok, duplicate and rejected settle an item; one the receipt leaves out goes again', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 500, text: '' })
    await clock.advance(MIN)
    await turn($, w, 2)
    w.replies.push({ status: 200, text: JSON.stringify({ results: [{ seq: 1, status: 'duplicate' }] }) })
    await clock.advance(MIN)
    w.replies.push({ status: 200, text: JSON.stringify({ results: [{ seq: 2, status: 'rejected', reason: 'budget' }] }) })
    await clock.advance(MIN)
    await clock.advance(MIN)
    expect(bodies(w).map(b => b.items.map(i => i.seq))).toEqual([[1], [1, 2], [2]])
  })

  test('400 invalid drops the items and logs once, to the debug log only', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 400, text: '{"error":"invalid"}' })
    await clock.advance(MIN)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(1)
    await turn($, w, 2)
    w.replies.push({ status: 400, text: '{"error":"invalid"}' })
    await clock.advance(MIN)
    expect(w.posts.length).toBe(2)
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]!.to).toBe('debug')
  })

  test('401 bad_signature and clock are sent again; clock leaves a hint in the status', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 401, text: '{"error":"bad_signature"}' }, { status: 401, text: '{"error":"clock"}' })
    await clock.advance(2 * MIN)
    const st = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(st.text).toMatch(/clock is off/)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(3)
    expect(new Set(w.posts.map(p => JSON.stringify((JSON.parse(p.init.body!) as Body).items))).size).toBe(1)
    const after = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(after.text).not.toMatch(/clock is off/)
  })

  test('413 sends the waiting items in smaller requests', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    for (let i = 1; i <= 4; i++) {
      await turn($, w, i)
      w.replies.push('throw')
      await clock.advance(MIN)
    }
    w.replies.push({ status: 413, text: '{"error":"too_large"}' })
    await clock.advance(MIN)
    await clock.advance(MIN)
    await clock.advance(MIN)
    expect(bodies(w).map(b => b.items.length)).toEqual([1, 2, 3, 4, 4, 2, 2])
    expect(booked(w)).toBe(4)
  })

  test('422 unknown_account rests the account for an hour and keeps its items', LONG, async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 422, text: '{"error":"unknown_account"}' })
    await clock.advance(MIN)
    await turn($, w, 1.5)
    await clock.advance(58 * MIN)
    expect(w.posts.length).toBe(1)
    await clock.advance(2 * MIN)
    expect(w.posts.length).toBe(2)
    expect(bodies(w)[1]!.items.map(i => [i.seq, amount(i)])).toEqual([[1, 1], [2, 0.5]])
  })

  test('422 mismatch drops that account\'s items and silences it for an hour; another account goes on', LONG, async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 422, text: '{"error":"mismatch"}' })
    await clock.advance(MIN)
    await turn($, w, 2)
    await clock.advance(2 * MIN)
    expect(w.posts.length).toBe(1)
    const st = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(st.text).toMatch(/a@example\.test: .*silent until .* \(mismatch\)/)
    login(w, B, 'b@example.test')
    await turn($, w, 2.5)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(2)
    expect(w.posts[1]!.init.headers?.['X-Report-Key']).toBe(reportKey(B))
    expect(bodies(w)[1]!.items.map(i => amount(i))).toEqual([0.5])
    // an hour later A reports again what it works from then on
    await clock.advance(60 * MIN)
    login(w, A)
    await turn($, w, 2.75)
    await clock.advance(MIN)
    expect(w.posts.at(-1)!.init.headers?.['X-Report-Key']).toBe(reportKey(A))
    expect((JSON.parse(w.posts.at(-1)!.init.body!) as Body).items.map(i => amount(i))).toEqual([0.25])
  })

  test('429, 3xx, 404, 503 unavailable, 5xx, non-JSON, network errors and timeouts keep the items for the next round', LONG, async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push(
      { status: 429, text: '{"error":"rate_limited"}' }, { status: 302, text: '' }, { status: 404, text: '404 page not found' },
      { status: 503, text: '{"error":"unavailable"}' }, { status: 502, text: 'Bad Gateway' }, { status: 200, text: '<html>' }, 'throw',
    )
    for (let i = 0; i < 7; i++) await clock.advance(MIN)
    expect(w.posts.length).toBe(7)
    w.replies.push('timeout')
    await clock.advance(MIN) // sent, no answer
    await clock.advance(15_000) // the plugin gives up after 15 s
    await clock.advance(45_000) // next round
    expect(w.posts.length).toBe(9)
    await clock.advance(MIN)
    expect(w.posts.length).toBe(9) // settled by the ninth
    expect(new Set(w.posts.map(p => JSON.stringify((JSON.parse(p.init.body!) as Body).items))).size).toBe(1)
  })

  test('offline: a long outage holds at most 20 items, and all the cost arrives afterwards', LONG, async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    let cost = 0
    for (let i = 0; i < 40; i++) {
      cost = Math.round((cost + 0.01) * 100) / 100
      await turn($, w, cost)
      w.replies.push('throw')
      await clock.advance(MIN)
    }
    expect(Math.max(...bodies(w).map(b => b.items.length))).toBe(MAX_ITEMS)
    for (let i = 0; i < 3; i++) await clock.advance(MIN)
    const amounts = new Map<number, number>()
    for (const it of sent(w)) {
      if (amounts.has(it.seq)) expect(amount(it)).toBe(amounts.get(it.seq)!) // never changed
      amounts.set(it.seq, amount(it))
    }
    expect(booked(w)).toBe(0.4)
    expect([...amounts.keys()]).toEqual([...amounts.keys()].sort((a, b) => a - b))
    expect(bodies(w).every(b => b.items.length <= MAX_ITEMS)).toBe(true)
  })

  test('a turn over 25 USD is split into items of at most 25 USD', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 60)
    await clock.advance(MIN)
    expect(sent(w).map(i => amount(i))).toEqual([25, 25, 10])
  })

  test('the end of the process: one last reading, sent at once', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    await clock.advance(MIN)
    w.cost = 1.3 // a /compact or a background agent after the last turn
    await $.session.end(end('prompt_input_exit'))
    expect(w.posts.length).toBe(2)
    expect(bodies(w)[1]!.items.map(i => amount(i))).toEqual([0.3])
  })

  test('a session that ran no turn in this process reports nothing, even at its end', async ($, on) => {
    const w = world(on)
    login(w, A)
    w.cost = 3
    mock.clock(on, { now: T0 })
    await start($)
    w.cost = 4
    await $.session.end(end('other'))
    expect(w.posts.length).toBe(0)
  })

  test('no shell, no toast, no status line; only CLAUDE_CONFIG_DIR is read; only our host is asked', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    await turn($, w, 1)
    w.replies.push({ status: 500, text: '' }, { status: 422, text: '{"error":"unknown_account"}' })
    await clock.advance(2 * MIN)
    await turn($, w, 2)
    await $.session.end(end('prompt_input_exit'))
    await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(w.runs).toBe(0)
    expect(w.toasts).toBe(0)
    expect(w.statuses).toBe(0)
    expect(new Set(w.envNames)).toEqual(new Set(['CLAUDE_CONFIG_DIR']))
    expect(w.posts.length).toBeGreaterThan(0)
    expect(w.posts.every(p => p.url === REPORT_URL && !('auth' in p.init))).toBe(true)
  })

  test('/account-meter status: mode, account, last report, last answer, open items', async ($, on) => {
    const w = world(on)
    login(w, A)
    const clock = mock.clock(on, { now: T0 })
    await start($)
    const before = await $.command.run({ command: 'account-meter', args: '' } as never)
    expect(before.text).toMatch(/Last report: none yet/)
    await turn($, w, 0.5)
    await clock.advance(MIN)
    await turn($, w, 0.75)
    const st = await $.command.run({ command: 'account-meter', args: 'status' } as never)
    expect(st.text).toMatch(/reporter mode/)
    expect(st.text).toMatch(/Account: a@example\.test/)
    expect(st.text).toMatch(/Last report: 2026-10-17T08:01:00Z, 1 item\(s\), 0\.5000 USD for a@example\.test/)
    expect(st.text).toMatch(/Last answer: 2026-10-17T08:01:00Z, 200, 1 ok/)
    expect(st.text).toMatch(/Open: a@example\.test: 0\.2500 USD collected/)
    expect(st.text).not.toContain(A)
    const other = await $.command.run({ command: 'account-meter', args: 'reset' } as never)
    expect(other.text).toBe('Usage: /account-meter status')
  })
})

// Each load of the plugin is a process of its own for the app.
let firstProcess = ''
describe('process id', () => {
  for (const n of [1, 2]) {
    test(`load ${n}`, async ($, on) => {
      const w = world(on)
      login(w, A)
      const clock = mock.clock(on, { now: T0 })
      await start($)
      await turn($, w, 1)
      await clock.advance(MIN)
      const id = bodies(w)[0]!.process
      if (n === 1) firstProcess = id
      else expect(id).not.toBe(firstProcess)
    })
  }
})
