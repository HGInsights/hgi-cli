#!/usr/bin/env bash
# Scripted real-run against a live server: Stories 1-4 (+ 5, 8, 9) with a real browser login.
#
#   HGI_BASE_URL=<server to test against> bash scripts/real-run-staging.sh | tee real-run.txt
#
# The only interactive step is the browser consent in step 1. Everything runs against an isolated,
# temporary config and cache directory ("clean machine"), so it never touches your own hgi login.
#
# Optional:
#   HGI_REALRUN_CALL_TOOL / HGI_REALRUN_CALL_INPUT   read-only tool + JSON input (default: the first
#                                                    `call` tool with no required fields)
#   HGI_REALRUN_RUN_TOOL  / HGI_REALRUN_RUN_INPUT    state-changing tool + JSON input for step 5
#                                                    (e.g. phoenix_invoke_agent with a staging test agent)
#   HGI_REALRUN_LIMITS_ORG=<slug>                    also flood the rate limit (Story 5, 429), but ONLY if the
#                                                    signed-in organization's slug equals <slug>. Name a
#                                                    DEDICATED test org here, never a shared one: the flood
#                                                    sends hundreds of parallel calls.
#                                                    Credit exhaustion needs no flag: if the org is already
#                                                    over quota, candidate lookups return exit 6 and that
#                                                    is recorded as the Story 5 credit-exhaustion check.
#   HGI_BIN=/path/to/hgi                             exercise an INSTALLED hgi (brew, binary tarball, npm) instead of
#                                                    `node dist/bin.js`; needs no Node and no checkout beyond this script
#   HGI_REALRUN_MODE=core                            release gate: login, whoami, tools list, one read-only call
#                                                    (+ logout and the token-leak scan). Exits non-zero only for
#                                                    those; it does not fail on the unexercised `run` happy path or
#                                                    credit exhaustion, which depend on the org's state
#   HGI_REALRUN_MODE=limits                          legacy: limits-only session (login, flood, credit, logout)
#   HGI_REALRUN_CREDIT_TOOL / HGI_REALRUN_CREDIT_INPUT  a tool that costs credits (limits mode)
#
# Tokens are never printed by hgi; this script reads them from the credentials file only to compare
# against the server and to scan its own transcript for leaks at the end.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${HGI_BIN:-}" ]; then HGI=("$HGI_BIN"); else HGI=(node "$root/dist/bin.js"); fi
REALRUN_MODE="${HGI_REALRUN_MODE:-main}"
export HGI_BASE_URL="${HGI_BASE_URL:?set HGI_BASE_URL to the server to test against}"
export HGI_DEBUG=1   # the whole session runs with debug logging; the leak scan covers it
EMPTY_JSON='{}'
SECRETS=()
remember() { SECRETS+=("$(jq -r .access_token "$(creds_file)")" "$(jq -r .refresh_token "$(creds_file)")"); }

work="$(mktemp -d)"
export HGI_CONFIG_DIR="$work/config"
export HGI_CACHE_DIR="$work/cache"
transcript="$work/transcript.txt"
: > "$transcript"
trap 'rm -rf "$work"' EXIT

failures=0
step() { printf '\n=== %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
pass() { printf '    PASS: %s\n' "$*"; }
fail() { printf '    FAIL: %s\n' "$*"; failures=$((failures + 1)); }
expect_exit() { # <expected> <label> <command...>
  local want="$1" label="$2"; shift 2
  local out err code
  out="$("$@" 2>"$work/err.txt")"; code=$?
  err="$(cat "$work/err.txt")"
  printf '%s\n%s\n' "$out" "$err" >> "$transcript"
  if [ "$code" -eq "$want" ]; then pass "$label (exit $code)"; else fail "$label: exit $code, wanted $want"; fi
  printf '    stdout: %s\n    stderr: %s\n' "${out:0:300}" "${err:0:400}"
  LAST_OUT="$out"; LAST_ERR="$err"; LAST_CODE="$code"
}
creds_file() { ls "$HGI_CONFIG_DIR"/credentials-*.json 2>/dev/null | head -n 1; }
cred() { jq -r ".$1" "$(creds_file)"; }
mcp() { # <token> <json-rpc body> -> prints body, headers to $work/h.txt
  curl -sS -D "$work/h.txt" -X POST "$HGI_BASE_URL/api/ai/mcp" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$2"
}
error_json() { # last {"schema"...} line of stderr (debug logging adds other lines)
  printf '%s\n' "$1" | grep '^{"schema"' | tail -n 1
}
json_rpc_body() { # strip an SSE envelope if the server used one
  awk '/^data: /{ sub(/^data: /, ""); print; exit } /^\{/{ print; exit }'
}

printf 'hgi real-run against %s\nhgi %s, node %s, %s\n' "$HGI_BASE_URL" "$("${HGI[@]}" --version)" "$(command -v node >/dev/null 2>&1 && node --version || echo 'none')" "$(uname -sm)"

if [ "${HGI_REALRUN_MODE:-main}" = "limits" ]; then
  step "L1. sign in as the dedicated limits test organization"
  expect_exit 0 "hgi auth login" "${HGI[@]}" auth login
  expect_exit 0 "whoami" "${HGI[@]}" auth whoami
  step "L2. rate limit (429): the per-organization window must be a throwaway org"
  hit=0
  for round in 1 2 3 4 5 6; do
    pids=()
    for i in $(seq 1 40); do
      ( "${HGI[@]}" tools list --refresh >/dev/null 2>"$work/rl.$round.$i" ; echo $? >"$work/rl.$round.$i.code" ) &
      pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null
    if grep -lq '^5$' "$work"/rl.$round.*.code 2>/dev/null; then hit=1; break; fi
  done
  if [ "$hit" = 1 ]; then pass "a flood produced exit 5 rate_limited"; else note "no 429 reached; raise load or lower the org's window, then re-run"; fail "rate_limited (exit 5) not exercised"; fi
  step "L3. credit exhaustion"
  ctool="${HGI_REALRUN_CREDIT_TOOL:?set HGI_REALRUN_CREDIT_TOOL (a credit-costing read-only tool)}"
  expect_exit 6 "credit-costing call on an exhausted org" "${HGI[@]}" call "$ctool" --input "${HGI_REALRUN_CREDIT_INPUT:-$EMPTY_JSON}"
  printf '%s' "$LAST_ERR" | jq -e '.error.code == "credit_limit_exceeded"' >/dev/null && pass "JSON error code credit_limit_exceeded" || fail "error body is not credit_limit_exceeded"
  step "L4. sign out"
  expect_exit 0 "logout" "${HGI[@]}" auth logout
  printf '\nfailures: %s\n' "$failures"
  exit "$failures"
fi

step "1. Story 1: sign in through the browser (approve the consent screen)"
expect_exit 0 "hgi auth login" "${HGI[@]}" auth login
file="$(creds_file)"
[ -n "$file" ] || { fail "no credentials file written"; exit 1; }
mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
[ "$mode" = "600" ] && pass "credentials file mode is 0600" || fail "credentials file mode is $mode"
ACCESS="$(cred access_token)"; REFRESH="$(cred refresh_token)"; remember

step "2. Story 1: whoami equals the server's userinfo"
expect_exit 0 "hgi auth whoami" "${HGI[@]}" auth whoami
direct="$(curl -sS "$HGI_BASE_URL/oauth/userinfo" -H "authorization: Bearer $ACCESS")"
for field in user.email organization.slug organization.name; do
  a="$(printf '%s' "$LAST_OUT" | jq -r ".$field")"; b="$(printf '%s' "$direct" | jq -r ".$field")"
  [ "$a" = "$b" ] && [ -n "$a" ] && pass "$field matches ($a)" || fail "$field differs: hgi '$a' vs server '$b'"
done

step "3. Story 2: tools list equals a direct tools/list from the same login"
expect_exit 0 "hgi tools list --json" "${HGI[@]}" tools list --json --refresh
hgi_list="$LAST_OUT"
mcp "$ACCESS" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"real-run","version":"0"}}}' >/dev/null
direct_list="$(mcp "$ACCESS" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | json_rpc_body)"
direct_version="$(tr -d '\r' < "$work/h.txt" | awk -F': ' 'tolower($1)=="x-mcp-version"{print $2}')"
a="$(printf '%s' "$hgi_list" | jq -c '[.tools[].name] | sort')"
b="$(printf '%s' "$direct_list" | jq -c '[.result.tools[].name] | sort')"
[ "$a" = "$b" ] && [ "$a" != "[]" ] && pass "tool names match ($(printf '%s' "$a" | jq length) tools)" || fail "tool lists differ"
[ "$(printf '%s' "$hgi_list" | jq -r .mcp_version)" = "$direct_version" ] && pass "MCP version matches ($direct_version)" || fail "MCP version differs (hgi $(printf '%s' "$hgi_list" | jq -r .mcp_version) vs $direct_version)"
printf '    verbs: %s\n' "$(printf '%s' "$hgi_list" | jq -c '[.tools[].verb] | group_by(.) | map({(.[0]): length}) | add')"
c1="$(printf '%s' "$hgi_list" | jq -r '[.tools[] | select(.verb=="call")] | length')"
c2="$(printf '%s' "$direct_list" | jq -r '[.result.tools[] | select(.annotations.readOnlyHint == true)] | length')"
[ "$c1" = "$c2" ] && pass "call/run split agrees with readOnlyHint ($c1 read-only)" || fail "call count $c1 vs readOnlyHint count $c2"

CALL_INPUT="${HGI_REALRUN_CALL_INPUT:-$EMPTY_JSON}"
RUN_TOOL="${HGI_REALRUN_RUN_TOOL:-}"
CANDIDATES=()
if [ -n "${HGI_REALRUN_CALL_TOOL:-}" ]; then CANDIDATES=("$HGI_REALRUN_CALL_TOOL"); else
  while IFS= read -r name; do [ -n "$name" ] && CANDIDATES+=("$name"); done < <(printf '%s' "$hgi_list" | jq -r '[.tools[] | select(.verb=="call" and (.required|length)==0)][].name' | head -n 40)
fi
note "${#CANDIDATES[@]} candidate read-only tools with no required fields"

probe() { # <tool> [input]: runs one call quietly, sets LAST_*
  local out err code
  out="$("${HGI[@]}" call "$1" --input "${2:-$CALL_INPUT}" 2>"$work/err.txt")"; code=$?
  err="$(cat "$work/err.txt")"
  printf '%s\n%s\n' "$out" "$err" >> "$transcript"
  LAST_OUT="$out"; LAST_ERR="$err"; LAST_CODE="$code"
}

CALL_TOOL=""; CREDIT_HITS=0; CREDIT_TOOL=""
step "4a. probing candidates for a working lookup (an org over quota answers exit 6 to costly ones)"
DOMAINS_INPUT='{"domains":["hginsights.com"]}'
for cand in "${CANDIDATES[@]}"; do
  PROBE_INPUT="$CALL_INPUT"
  probe "$cand"
  if [ "$LAST_CODE" = 2 ] || [ "$LAST_CODE" = 3 ]; then PROBE_INPUT="$DOMAINS_INPUT"; probe "$cand" "$PROBE_INPUT"; fi
  case "$LAST_CODE" in
    0) note "$cand: exit 0 (usable)"; [ -z "$CALL_TOOL" ] && { CALL_TOOL="$cand"; CALL_INPUT="$PROBE_INPUT"; }; [ "$CREDIT_HITS" -gt 0 ] && break ;;
    6) note "$cand: exit 6 credit_limit_exceeded"; CREDIT_HITS=$((CREDIT_HITS + 1)); [ -z "$CREDIT_TOOL" ] && { CREDIT_TOOL="$cand"; CREDIT_INPUT="$PROBE_INPUT"; } ; [ -n "$CALL_TOOL" ] && break ;;
    *) note "$cand: exit $LAST_CODE (skipped)" ;;
  esac
done

step "4. Story 3: a read-only call (${CALL_TOOL:-none found})"
if [ -z "$CALL_TOOL" ]; then fail "no read-only tool with no required fields succeeded; set HGI_REALRUN_CALL_TOOL/INPUT"; else
  expect_exit 0 "hgi call $CALL_TOOL" "${HGI[@]}" call "$CALL_TOOL" --input "$CALL_INPUT"
  printf '%s' "$LAST_OUT" | jq -e . >/dev/null 2>&1 && pass "stdout is valid JSON" || fail "stdout is not valid JSON"
  printf '%s' "$LAST_ERR" | grep -q credit_cost && pass "credit cost reported" || fail "no credit_cost line on stderr"
  key="$(printf '%s' "$LAST_OUT" | jq -r 'if type=="object" then keys[0] else empty end')"
  if [ -n "$key" ]; then
    expect_exit 0 "--select $key" "${HGI[@]}" call "$CALL_TOOL" --input "$CALL_INPUT" --select "$key"
    [ "$(printf '%s' "$LAST_OUT" | jq -r 'keys | join(",")')" = "$key" ] && pass "only '$key' returned" || fail "--select returned other fields"
  fi
  for f in jsonl csv yaml table; do expect_exit 0 "-f $f" "${HGI[@]}" call "$CALL_TOOL" --input "$CALL_INPUT" -f "$f"; done
fi

if [ "$REALRUN_MODE" != core ]; then
step "4b. Story 5: credit exhaustion (this org is expected to be over quota)"
if [ "$CREDIT_HITS" -gt 0 ]; then
  expect_exit 6 "hgi call $CREDIT_TOOL on an over-quota org" "${HGI[@]}" call "$CREDIT_TOOL" --input "$CREDIT_INPUT"
  error_json "$LAST_ERR" | jq -e '.error.code == "credit_limit_exceeded" and .error.exit_code == 6' >/dev/null && pass "JSON error body: credit_limit_exceeded / exit_code 6" || fail "error body is not credit_limit_exceeded"
elif [ -n "${HGI_REALRUN_CREDIT_TOOL:-}" ]; then
  expect_exit 6 "hgi call $HGI_REALRUN_CREDIT_TOOL" "${HGI[@]}" call "$HGI_REALRUN_CREDIT_TOOL" --input "${HGI_REALRUN_CREDIT_INPUT:-$EMPTY_JSON}"
else
  note "NOT EXERCISED: no candidate returned exit 6, so this org still has credits (set HGI_REALRUN_CREDIT_TOOL/INPUT for a costly tool)"
  fail "credit exhaustion (exit 6) was not exercised"
fi

signed_org="$(printf '%s' "$direct" | jq -r '.organization.slug')"
if [ -z "$RUN_TOOL" ] && [ -n "${HGI_REALRUN_LIMITS_ORG:-}" ] && [ "$signed_org" = "$HGI_REALRUN_LIMITS_ORG" ] && printf '%s' "$hgi_list" | jq -e '[.tools[].name] | index("phoenix_invoke_agent") and index("phoenix_list_agents")' >/dev/null; then
  note "org '$signed_org' is the named test org: discovering an agent with phoenix_list_agents to run"
  agents="$("${HGI[@]}" call phoenix_list_agents --input '{}' 2>/dev/null)"
  agent_id="$(printf '%s' "$agents" | jq -r '[.. | objects | select(has("id") and has("name"))][0].id // empty')"
  agent_name="$(printf '%s' "$agents" | jq -r '[.. | objects | select(has("id") and has("name"))][0].name // empty')"
  if [ -n "$agent_id" ]; then
    note "running agent '$agent_name' ($agent_id) in org '$signed_org' (starts a real run)"
    RUN_TOOL=phoenix_invoke_agent
    HGI_REALRUN_RUN_INPUT="$(jq -nc --arg id "$agent_id" '{agent_id:$id, inputs:{domain:"hginsights.com"}}')"
  else
    note "phoenix_list_agents returned no agent in org '$signed_org'"
  fi
fi

step "5. Story 4: run a state-changing tool; wrong verbs fail without side effects"
if [ -n "$RUN_TOOL" ]; then
  expect_exit 0 "hgi run $RUN_TOOL" "${HGI[@]}" run "$RUN_TOOL" --input "${HGI_REALRUN_RUN_INPUT:-$EMPTY_JSON}"
  expect_exit 10 "hgi call $RUN_TOOL (wrong verb)" "${HGI[@]}" call "$RUN_TOOL" --input "${HGI_REALRUN_RUN_INPUT:-$EMPTY_JSON}"
  printf '%s' "$LAST_ERR" | grep -q "hgi run" && pass "error names hgi run" || fail "error does not name hgi run"
else
  note "NOT RUN: set HGI_REALRUN_RUN_TOOL (and _INPUT), e.g. phoenix_invoke_agent against a staging test agent"
  fail "Story 4 happy path (run) was not exercised"
fi
[ -n "$CALL_TOOL" ] && { expect_exit 10 "hgi run $CALL_TOOL (wrong verb on a read-only tool)" "${HGI[@]}" run "$CALL_TOOL" --input "$CALL_INPUT"; printf '%s' "$LAST_ERR" | grep -q "hgi call" && pass "error names hgi call" || fail "error does not name hgi call"; }

step "6. Story 5: failure classes against the live server"
expect_exit 2 "invalid input (client-side schema)" "${HGI[@]}" call "${CALL_TOOL:-x}" --input '{"__definitely_not_a_field__":[1,2,3],"limit":"ten"}'
expect_exit 2 "unknown tool" "${HGI[@]}" call this_tool_does_not_exist --input '{}'
if [ -n "$CALL_TOOL" ]; then
  expect_exit 3 "tool error (server-side validation, client validation skipped)" "${HGI[@]}" call "$CALL_TOOL" --input '{"limit":-1,"query":12345,"domain":[1]}' --no-validate
fi
note "401: tamper the stored access token; hgi must refresh exactly once and succeed"
jq '.access_token = "tampered-access-token-value-0000"' "$(creds_file)" > "$work/c.json" && cat "$work/c.json" > "$(creds_file)"
expect_exit 0 "call after a tampered access token" "${HGI[@]}" call "${CALL_TOOL:-x}" --input "$CALL_INPUT"
[ "$(cred refresh_token)" != "$REFRESH" ] && pass "refresh token rotated (one refresh happened)" || fail "no refresh happened"
ACCESS="$(cred access_token)"; REFRESH="$(cred refresh_token)"; remember
note "unreachable server and bad TLS are exercised against a fake server in the test suite"

step "7. Story 8: five parallel calls right after the access token expired"
jq '.expires_at = 1' "$(creds_file)" > "$work/c.json" && cat "$work/c.json" > "$(creds_file)"
pids=(); for i in 1 2 3 4 5; do ( "${HGI[@]}" call "${CALL_TOOL:-x}" --input "$CALL_INPUT" >/dev/null 2>"$work/p.$i"; echo $? >"$work/p.$i.code" ) & pids+=($!); done
wait "${pids[@]}"
ok=0; for i in 1 2 3 4 5; do [ "$(cat "$work/p.$i.code")" = 0 ] && ok=$((ok + 1)); done
[ "$ok" = 5 ] && pass "all 5 succeeded" || fail "$ok of 5 succeeded"
expect_exit 0 "whoami afterwards (still signed in)" "${HGI[@]}" auth whoami
ACCESS="$(cred access_token)"; REFRESH="$(cred refresh_token)"; remember

signed_org="$(printf '%s' "$direct" | jq -r '.organization.slug')"
if [ -n "${HGI_REALRUN_LIMITS_ORG:-}" ] && [ "$signed_org" != "$HGI_REALRUN_LIMITS_ORG" ]; then
  step "7b. Story 5: rate limit (429) flood REFUSED"
  note "signed in as org '$signed_org', but the flood is only allowed against '$HGI_REALRUN_LIMITS_ORG'; skipping it"
  fail "rate limit (exit 5) not exercised: wrong organization for the flood"
elif [ -n "${HGI_REALRUN_LIMITS_ORG:-}" ]; then
  step "7b. Story 5: rate limit (429) by flooding the per-organization window"
  flood_tool="${CALL_TOOL:-}"
  hit=0
  note "flooding org '$signed_org' as allowed by HGI_REALRUN_LIMITS_ORG"
  for round in 1 2 3 4 5 6 7 8; do
    pids=()
    for i in $(seq 1 60); do
      if [ -n "$flood_tool" ]; then ( "${HGI[@]}" call "$flood_tool" --input "$CALL_INPUT" >/dev/null 2>"$work/rl.$round.$i"; echo $? >"$work/rl.$round.$i.code" ) &
      else ( "${HGI[@]}" tools list --refresh >/dev/null 2>"$work/rl.$round.$i"; echo $? >"$work/rl.$round.$i.code" ) &
      fi
      pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null
    n5="$(cat "$work"/rl.$round.*.code 2>/dev/null | grep -c '^5$')"
    note "round $round: $n5 of 60 parallel calls ended with exit 5 (rate_limited)"
    if [ "$n5" -gt 0 ]; then hit=1; sample="$(for f in "$work"/rl.$round.*.code; do [ "$(cat "$f")" = 5 ] && { error_json "$(cat "${f%.code}")"; break; }; done)"; printf '%s\n' "$sample" >> "$transcript"; break; fi
  done
  if [ "$hit" = 1 ]; then
    pass "a flood produced exit 5 rate_limited"
    printf '%s' "$sample" | jq -e '.error.code == "rate_limited" and .error.exit_code == 5' >/dev/null 2>&1 && pass "JSON error body: rate_limited / exit_code 5 ($(printf '%s' "$sample" | jq -c '.error.details'))" || fail "rate-limited error body malformed: $sample"
  else
    fail "rate_limited (exit 5) was not reached; raise the load or lower the org's window"
  fi
  sleep 3
fi

fi

step "8. Story 9: logout revokes server-side and removes the file"
expect_exit 0 "hgi auth logout" "${HGI[@]}" auth logout
[ -z "$(creds_file)" ] && pass "credentials file is gone" || fail "credentials file still exists"
code="$(curl -sS -o "$work/t.json" -w '%{http_code}' -X POST "$HGI_BASE_URL/oauth/token" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$REFRESH" --data-urlencode "client_id=$HGI_BASE_URL/.well-known/oauth-clients/hgi-cli.json")"
[ "$code" -ge 400 ] && pass "replaying the refresh token at /oauth/token fails (HTTP $code: $(jq -r .error "$work/t.json"))" || fail "refresh token still works after logout (HTTP $code)"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$HGI_BASE_URL/oauth/userinfo" -H "authorization: Bearer $ACCESS")"
[ "$code" = 401 ] && pass "access token fails immediately at userinfo (HTTP 401)" || fail "userinfo still accepts the access token (HTTP $code)"
note "MCP endpoint caches validated tokens for about 30 seconds; polling up to 45 s"
mcp_code=000
for i in $(seq 1 45); do
  mcp_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$HGI_BASE_URL/api/ai/mcp" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}')"
  [ "$mcp_code" = 401 ] && break; sleep 1
done
[ "$mcp_code" = 401 ] && pass "access token rejected at the MCP endpoint after ~${i}s" || fail "MCP endpoint still accepts the access token after 45 s (HTTP $mcp_code)"

step "9. no token appears anywhere in this transcript"
leaks=0
for secret in "${SECRETS[@]}"; do
  if [ -n "$secret" ] && grep -qF -- "$secret" "$transcript"; then leaks=$((leaks + 1)); fi
done
[ "$leaks" = 0 ] && pass "none of the ${#SECRETS[@]} access/refresh tokens seen this session appear in captured hgi output (debug logging on)" || fail "$leaks token(s) found in captured output"

printf '\nfailures: %s\n' "$failures"
exit "$failures"
