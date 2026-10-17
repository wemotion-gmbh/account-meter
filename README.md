# account-meter

Claude Code plugin (engine API, no shell in reporter mode) for claude-accounts, wemotion's
overview of its Claude accounts. One plugin, two modes, chosen by where it runs:

| Mode | When | What |
|---|---|---|
| **reporter** | everywhere (installed from the wemotion marketplace, or `--plugin-dir`) | reports the **estimated cost in USD** of each Claude Code session to claude-accounts, per Claude account |
| **box** | only when the plugin folder is `/opt/claude-box/plugin` (the claude-accounts box image) | measures the 5-hour / 7-day usage of the box's account without a model request and writes `~/.claude-box/usage.json` |

`/account-meter status` shows the mode, the account, the last report, the last answer and what is
still waiting.

## Reporter mode

**Which account.** `oauthAccount.accountUuid` from `$CLAUDE_CONFIG_DIR/.claude.json`, else
`~/.claude.json` (the home folder is taken from the plugin's own folder, as no `HOME` is read). The
file is read again at a turn's start only when it changed, so after a `/login` the next turn counts
for the new account. Without an `accountUuid` (API key, gateway) nothing is reported. The plugin
reads no environment variable but `CLAUDE_CONFIG_DIR`, never a token, and asks Anthropic nothing.

**What counts.** Claude Code's own cost estimate (`/cost`, list price unless managed settings set
other prices), as the growth per session in this process:
- the base is the sum at the session's first turn in this process (a resumed or forked session
  brings its old sum, which is never reported again);
- growth counts after each of its own turns, for the account at that turn's start;
- a new session id (`/clear`, `/resume`) or a falling sum starts a new base: jumps never count;
- at the end of the process one last reading (a `/compact` after the last turn) is sent at once.

**What is sent**, at most once a minute per account, bundled:

```json
{"schema":1,"process":"a1b2c3d4e5f60718","claude_version":"2.1.302",
 "items":[{"seq":7,"cost_delta_usd":0.4213,"check":{"five_hour_resets_at":1792231200,"seven_day_resets_at":1792656000}}]}
```

- `process`: random per plugin start, `seq`: rising per process (the app counts each once);
- `cost_delta_usd`: the cost growth, at most 25 per item;
- `check`: the reset times of the turn's rate limits, only to cross-check against the box
  measurement of that account (a wrong account is refused), never shown.

No prompts, answers, file names, paths, repositories, hostnames or tokens. Nothing is stored on
disk: a crash loses at most the last minute ("rather too little than twice").

**Where.** Only `POST https://claude-accounts.k8s.backbone.canou.io/report/v1/usage`
(`scripts/check-surface.sh` checks this in CI). No redirect is trusted: only a `200` with a JSON
receipt settles items.

**How it is secured** (the contract with the claude-accounts app):
- HTTPS only, the address is fixed in the code;
- the account UUID never goes over the wire: `X-Report-Key` = first 16 hex of
  `sha256("claude-accounts:" + uuid)`, `X-Report-Signature` = `HMAC-SHA256(uuid, time + "\n" + body)`,
  `X-Report-Time` within ±5 min;
- the app takes reports only for accounts it knows, drops repeats of (`process`, `seq`), cross-checks
  the reset times against its own box measurement and caps the amounts (budget);
- the UUID is no password: at worst the cost statistics are wrong. It gives no access to accounts,
  boxes or credentials.

**Answers.** `200` receipt: `ok`/`duplicate`/`rejected` settle an item. `400 invalid`: dropped, logged
once (debug log). `413`: smaller requests. `422 unknown_account`: this account rests for 1 h, items
kept. `422 mismatch`: this account stays silent in this process. Anything else (`401`, `429`, `3xx`,
`404`, `5xx`, timeout, no JSON): kept, sent again in the next round. An item never changes after its
first sending. The session is never disturbed: no toast, no status line, no model request.

## Box mode

In the box image the plugin is copied to `/opt/claude-box/plugin/` and loaded by
`~/.claude/settings.json` `{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "/opt/claude-box/plugin"}}` (the
marketplace copy must be turned off there by managed settings, or it would run twice). Every `ACCOUNT_METER_INTERVAL_S` seconds
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

## Release

Only from `main` after green CI (`.github/workflows/test.yml`): raise `version` in
`.claude-plugin/plugin.json` (clients update only when it rises), tag `v<version>`. The marketplace
entry and the box image pin that tag.
