# account-meter

Claude Code plugin (engine API, no shell in reporter mode) for claude-accounts, wemotion's
overview of its Claude accounts. One plugin, two modes, chosen by where it runs:

| Mode | When | What |
|---|---|---|
| **reporter** | everywhere (installed from the wemotion marketplace, or `--plugin-dir`) | reports the **estimated cost in USD** of each Claude Code session to claude-accounts, per Claude account |
| **box** | only when the plugin folder is `/opt/claude-box/plugin` (the claude-accounts box image) | measures the 5-hour / 7-day usage of the box's account without a model request and writes `~/.claude-box/usage.json` |

`/account-meter status` shows the mode, the account, the last report, the last answer and what is
still waiting.

## Install

Accounts in the wemotion organisation get it with the marketplace (claude.ai org sync, auto install).
Anyone else with access to the private marketplace repo (also on a private Claude account, and in
every config folder you use with `CLAUDE_CONFIG_DIR`):

```
/plugin install account-meter --marketplace wemotion-gmbh/claude-plugins
```

Installed twice (a local copy beside the org sync is fine: Claude Code then runs only the local
one; two local copies both run), it still counts once: both copies send the same ranges of the same
session, and the app books each range once.

## Reporter mode

**Which account.** `oauthAccount.accountUuid` from `$CLAUDE_CONFIG_DIR/.claude.json`, else
`~/.claude.json` (the home folder is taken from the plugin's own folder, as no `HOME` is read). The
file is looked at every second (`stat`; read only when it changed). Every Claude Code window on one
config folder shares it, and a `/login` in any of them switches them all: what grew up to that
moment counts for the old account, from then on for the new one, also in the middle of a turn. A
file that is half written or missing for a moment keeps the account known so far. Without an `accountUuid` (API key, gateway) nothing is reported. The plugin
reads no environment variable but `CLAUDE_CONFIG_DIR`, never a token, and asks Anthropic nothing.

**What counts.** Claude Code's own cost estimate (`/cost`, list price unless managed settings set
other prices), as the growth per session in this process:
- the base is the sum at the session's first turn in this process (a resumed or forked session
  brings its old sum, which is never reported again);
- growth counts after each of its own turns;
- what grows outside a turn's end (a background agent, a `/compact`) is read when a subagent ends,
  every minute, right before `/login` and `/logout` (then sent at once) and when the account file
  switches, for the account logged in at that moment. So a `/login`, here or in another window,
  never moves cost to the other account;
- a new session id (`/clear`, `/resume`) or a falling sum starts a new base: jumps never count
  (after a fall the session gets a new key, see `session` below);
- at the end of the process one last reading is sent at once.

**What is sent**, at most once a minute per account, bundled:

```json
{"schema":2,"process":"a1b2c3d4e5f60718","claude_version":"2.1.302",
 "items":[{"seq":7,"session":"9f2c4e1a0b3d5f68","from_usd":3.2,"to_usd":3.6213,
           "check":{"five_hour_resets_at":1792231200,"seven_day_resets_at":1792656000}}]}
```

- `process`: random per plugin start, `seq`: rising per process (the app counts each once);
- `session`: first 16 hex of `sha256("account-meter:" + session id + ":" + epoch)`, `epoch` = falls
  of the sum seen in this process (normally 0); nothing about the session can be read from it;
- `from_usd`, `to_usd`: the stretch of the session's running sum this item covers (micro dollar
  precision, at most 25 per item). The app books only what of a range is not booked yet for that
  session, so a second copy of the plugin, or any repeat, counts nothing. Known limit: the same
  session open in two processes at once (`--resume` twice) starts both at the same sum, and that
  overlap counts once ("rather too little than twice");
- `check`: the reset times of the turn's rate limits, only to cross-check against the box
  measurement of that account (a wrong account is refused), never shown.

No prompts, answers, file names, paths, repositories, hostnames or tokens. Nothing is stored on
disk: a crash loses at most the last minute ("rather too little than twice").

**Where.** Only `POST https://ai-accounts.k8s.backbone.canou.io/report/v1/usage`
(`scripts/check-surface.sh` checks this in CI). No redirect is trusted: only a `200` with a JSON
receipt settles items.

**How it is secured** (the contract with the claude-accounts app):
- HTTPS only, the address is fixed in the code;
- the account UUID never goes over the wire: `X-Report-Key` = first 16 hex of
  `sha256("claude-accounts:" + uuid)`, `X-Report-Signature` = `HMAC-SHA256(uuid, time + "\n" + body)`,
  `X-Report-Time` within ±5 min;
- the app takes reports only for accounts it knows, drops repeats of (`process`, `seq`) and of
  session ranges, cross-checks
  the reset times against its own box measurement and caps the amounts (budget);
- the UUID is no password: at worst the cost statistics are wrong. It gives no access to accounts,
  boxes or credentials.

**Answers.** `200` receipt: `ok`/`duplicate`/`rejected` settle an item. `400 invalid`: dropped, logged
once (debug log). `413`: smaller requests. `422 unknown_account`: this account rests for 1 h, items
kept, and a toast tells the user once per process and account: "Dein Claude-Konto <E-Mail> ist nicht in
AI-Accounts hinterlegt, Kosten werden nicht erfasst." (nothing more goes to the server). `422 mismatch`: that account's items are dropped and it stays silent for 1 h. Anything else (`401`, `429`, `3xx`,
`404`, `5xx`, timeout, no JSON): kept, sent again in the next round. An item never changes after its
first sending. The session is never disturbed otherwise: no other toast, no status line, no model request.

## Box mode

In the box image the plugin is copied to `/opt/claude-box/plugin/` and loaded by
`~/.claude/settings.json` `{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "/opt/claude-box/plugin"}}`. The boxes
have no marketplace and no org-synced copy (no `~/.claude/plugins` there, checked 17.10.); should one
ever appear, it would run as a reporter beside the box meter and only count turns, which the box does
not run. Every `ACCOUNT_METER_INTERVAL_S` seconds
(60..3600, default 300; after a start with a random 0..60 s offset) a short-lived child
`claude -p --input-format stream-json ... --setting-sources ''` answers the SDK control request
`get_usage` (no model request; the debug log is checked for `/v1/messages`). A new login, refresh or
logout (`stat` on `.credentials.json` every 10 s) is measured at once; errors back off up to 30 min.
`usage.json` is written atomically and read by the box agent. `/clear` and `/resume` keep the meter
running.

## Develop

```
claude plugin test            # all tests (engine test host, mocked world)
./scripts/check-surface.sh    # fetch only our host, no auth, reporter env CLAUDE_CONFIG_DIR only
claude plugin validate .
```

Try it on a machine: `claude --plugin-dir <this folder>`, then `/account-meter status`.

A test that simulates ten minutes or more passes `LONG` (`{ timeoutMs: 30_000 }`) as its second
argument: every simulated second runs the 1-s watch, which on a busy CI builder outlasts the kit's
default limit of 5 s.

## Release

Only from `main` after green CI (`.github/workflows/test.yml`): raise `version` in
`.claude-plugin/plugin.json` (clients update only when it rises), tag `v<version>`. The marketplace
entry and the box image pin that tag.
