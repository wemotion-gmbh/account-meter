// account-meter: one plugin, two modes (README.md).
//   box       the plugin runs from /opt/claude-box/plugin (the claude-accounts
//             box image): measures 5h / 7d into ~/.claude-box/usage.json (box.ts).
//   reporter  anywhere else: reports the estimated cost per Claude account to
//             claude-accounts (reporter.ts).
// /account-meter status shows what it does in this process.
import type { EngineInterface, Register } from 'claude-code'
import { boxEnd, boxStart, boxStatus, newBox } from './box'
import { newReporter, reporterEnd, reporterStart, reporterStatus, reporterTurnComplete, reporterTurnStart } from './reporter'

export const BOX_ROOT = '/opt/claude-box/plugin'
export type Mode = 'box' | 'reporter'

// The plugin's own folder as the engine loaded it, also resolved, so a link
// to or from the box folder cannot tell the two copies apart.
export async function modeOf($: EngineInterface): Promise<Mode> {
  const trim = (p: string) => p.replace(/\/+$/, '')
  const root = trim($.plugin.root)
  if (root === BOX_ROOT) return 'box'
  try {
    const real = (await $.fs.stat(root, { resolve: true })).realPath
    if (real && trim(real) === BOX_ROOT) return 'box'
  } catch {
    // unresolvable: the folder as given decides
  }
  return 'reporter'
}

export const register: Register = on => {
  const box = newBox()
  const report = newReporter()
  // Decided once per load, at the first hook that asks.
  let mode: Promise<Mode> | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({
        name: 'account-meter',
        description: 'account-meter: /account-meter status shows the mode, the account and the last report',
        argumentHint: 'status',
        immediate: true,
      })
    } catch {
      // no command, the meter still works
    }
    if ((await (mode ??= modeOf($))) === 'box') await boxStart($, box)
    else await reporterStart($, report)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if ((await (mode ??= modeOf($))) === 'reporter') await reporterTurnStart($, report, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if ((await (mode ??= modeOf($))) === 'reporter') await reporterTurnComplete($, report, e)
    return done
  })

  on('session.end', async ($, e, next) => {
    if ((await (mode ??= modeOf($))) === 'box') boxEnd(box, e.reason)
    else await reporterEnd($, report, e, () => next.budget.remainingMs)
    return next(e)
  })

  on('command.run', { command: 'account-meter' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'status') return { text: 'Usage: /account-meter status' }
    const text = (await (mode ??= modeOf($))) === 'box' ? boxStatus(box) : await reporterStatus($, report)
    return { text }
  })
}
