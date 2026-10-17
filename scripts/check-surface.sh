#!/usr/bin/env bash
# Surface check of the hooks module (README "Safety", CI .github/workflows/test.yml).
# grep based on purpose: the code is written so that this holds by reading it
# (one URL constant, string literals for environment names, `$` spelled out).
#   - $.http.fetch only with REPORT_URL, which is exactly our endpoint, never
#     with a credential (`auth`); no other URL in the code
#   - the reporter (every file but box.ts) reads no environment variable but
#     CLAUDE_CONFIG_DIR, runs no process; box.ts never fetches
#   - nowhere a model request, $.store or an environment write
# Test files are not part of the module and are left out.
set -euo pipefail
cd "$(dirname "$0")/.."

URL='https://ai-accounts.k8s.backbone.canou.io/report/v1/usage'
BOX_ENV='ACCOUNT_METER_INTERVAL_S ACCOUNT_METER_JITTER_MS CLAUDE_ACCOUNT_METER_CHILD CLAUDE_CODE_EXECPATH CLAUDE_CONFIG_DIR HOME'
fail=0
bad() {
	echo "check-surface: $*" >&2
	fail=1
}

src=()
for f in hooks/*.ts hooks/*.tsx; do
	[ -e "$f" ] || continue
	case "$f" in *.test.ts | *.test.tsx) continue ;; esac
	src+=("$f")
done
[ "${#src[@]}" -gt 0 ] || { echo "check-surface: no hooks sources" >&2; exit 1; }
reporter=()
for f in "${src[@]}"; do [ "$f" = hooks/box.ts ] || reporter+=("$f"); done

# 1. One URL constant, exactly our endpoint.
defs="$(grep -n 'REPORT_URL *=' "${src[@]}" || true)"
[ "$(printf '%s\n' "$defs" | grep -c .)" -eq 1 ] || bad "want exactly one REPORT_URL definition, found: ${defs:-none}"
printf '%s\n' "$defs" | grep -qF "export const REPORT_URL = '$URL'" || bad "REPORT_URL is not '$URL': $defs"

# 2. Every fetch goes to REPORT_URL; there is one.
fetches="$(grep -n 'http\.fetch' "${src[@]}" || true)"
[ -n "$fetches" ] || bad 'no $.http.fetch found (the check would prove nothing)'
others="$(printf '%s\n' "$fetches" | grep -v '\$\.http\.fetch(REPORT_URL, ' | grep . || true)"
[ -z "$others" ] || bad "fetch not to REPORT_URL: $others"
if grep -n 'http\.fetch' hooks/box.ts >/dev/null 2>&1; then bad 'box.ts must not fetch'; fi

# 3. No other URL anywhere in the code.
urls="$(grep -noE "(https?|wss?)://[^ '\"\`)]*" "${src[@]}" | grep -vF ":$URL" || true)"
[ -z "$urls" ] || bad "other URLs in the code: $urls"

# 4. No credential on any request.
creds="$(grep -nE '\bauth\s*[:,}]|\bauthorize\s*\(|\bauth\s*=' "${src[@]}" || true)"
[ -z "$creds" ] || bad "credential use: $creds"

# 5. Environment: names only as string literals; the reporter reads CLAUDE_CONFIG_DIR only.
dyn="$(grep -n 'env\.get(' "${src[@]}" | grep -vE "env\.get\('[A-Z0-9_]+'\)" || true)"
[ -z "$dyn" ] || bad "env.get without a string literal: $dyn"
for f in "${reporter[@]}"; do
	names="$(grep -oE "env\.get\('[A-Z0-9_]+'\)" "$f" | sed -E "s/env\.get\('([A-Z0-9_]+)'\)/\1/" | sort -u || true)"
	for n in $names; do [ "$n" = CLAUDE_CONFIG_DIR ] || bad "$f reads env $n"; done
done
if [ -f hooks/box.ts ]; then
	for n in $(grep -oE "env\.get\('[A-Z0-9_]+'\)" hooks/box.ts | sed -E "s/env\.get\('([A-Z0-9_]+)'\)/\1/" | sort -u); do
		case " $BOX_ENV " in *" $n "*) ;; *) bad "box.ts reads env $n (not in its list)" ;; esac
	done
fi
if grep -nE 'env\.set\(' "${src[@]}" >/dev/null; then bad "env.set used: $(grep -nE 'env\.set\(' "${src[@]}")"; fi

# 6. No process outside box.ts, no model request, no $.store, no dynamic noun access.
procs="$(grep -nE '\$\.process\b' "${reporter[@]}" || true)"
[ -z "$procs" ] || bad "process use outside box.ts: $procs"
model="$(grep -nE '\$\.(model|store|agent)\b|tool\.call|\$\[' "${src[@]}" || true)"
[ -z "$model" ] || bad "model, store, agent or dynamic use of \$: $model"

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "check-surface: ok (${#src[@]} files: fetch only $URL without auth; reporter env CLAUDE_CONFIG_DIR only)"
