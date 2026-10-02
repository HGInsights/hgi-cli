#!/usr/bin/env bash
# Apply the repository security configuration. Idempotent. Dry run by default.
#
#   bash scripts/configure-repo-security.sh --release-team <team-slug>            # print what would change
#   bash scripts/configure-repo-security.sh --release-team <team-slug> --apply    # change it
#
# Run this AFTER the repository is public (GitHub Free exposes none of these APIs for private
# repositories), and BEFORE any release secret is stored. --apply refuses to run on a private
# repository, if the release team has fewer than two members (the release environment forbids
# self-review, so a lone member could never approve their own release), or if a team named in
# CODEOWNERS lacks write access or has fewer than two members (the main ruleset requires an approving
# code-owner review with no bypass: no write access means the rule enforces nothing, and a one-person
# team means that person's own pull requests can never merge).
#
# Configures:
#   * secret scanning + push protection, Dependabot alerts and security updates, private vulnerability reporting,
#     read-only workflow token, and manual approval of workflow runs from outside contributors
#   * ruleset "main protection": PR + 1 approving review + code owner review, required checks, no force push, no deletion, no bypass
#   * ruleset "release tags": only the repository `maintain` role (and admins) may create, move or delete v* tags.
#     GitHub rejects a team as a ruleset bypass actor on this plan, so <team-slug> is granted the `maintain`
#     role on the repository instead and the bypass is by role
#   * environment "release": reviewers = the members of <team-slug>, self-review forbidden, deployments limited to v* TAGS
#     (a branch named v1.2.3 must not match); any other existing deployment policy is removed
set -euo pipefail

repo="${HGI_REPO:-HGInsights/hgi-cli}"
org="${repo%%/*}"
apply=false
team=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --release-team) team="${2:?--release-team needs a slug}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$team" ] || { echo "pass --release-team <team-slug> (the people allowed to cut releases)" >&2; exit 2; }

visibility="$(gh api "repos/$repo" --jq .visibility)"
team_id="$(gh api "orgs/$org/teams/$team" --jq .id)"
members="$(gh api "orgs/$org/teams/$team/members" --paginate --jq '.[].login' | grep -c . || true)"
echo "repository: $repo ($visibility), release team: $team (id $team_id), members: $members"

codeowner_teams="$(grep -ohE '@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' "$(dirname "${BASH_SOURCE[0]}")/../.github/CODEOWNERS" | sort -u | sed 's#^@[^/]*/##')"
codeowner_problems=""
for slug in $codeowner_teams; do
  # The Accept header is required: without it GitHub answers 204 No Content and there is no body to read.
  push="$(gh api -H 'Accept: application/vnd.github.v3.repository+json' "orgs/$org/teams/$slug/repos/$repo" --jq .permissions.push 2>/dev/null || echo false)"
  count="$(gh api "orgs/$org/teams/$slug/members" --paginate --jq '.[].login' 2>/dev/null | grep -c . || true)"
  [ "$push" = true ] || codeowner_problems="$codeowner_problems $slug(no write access)"
  [ "${count:-0}" -ge 2 ] || codeowner_problems="$codeowner_problems $slug(fewer than 2 members)"
done
[ -z "$codeowner_problems" ] || echo "CODEOWNERS teams that would break code-owner review on $repo:$codeowner_problems"

if $apply; then
  [ "$visibility" = public ] || { echo "refusing: $repo is $visibility; these settings are unavailable until it is public" >&2; exit 1; }
  [ "$members" -ge 2 ] || { echo "refusing: the release team needs at least two members so reviews and release approvals are possible" >&2; exit 1; }
  [ -z "$codeowner_problems" ] || { echo "refusing: fix these CODEOWNERS teams first:$codeowner_problems" >&2; exit 1; }
fi

required_checks='[
  {"context":"test (ubuntu-latest, node 22)"},
  {"context":"test (ubuntu-latest, node 24)"},
  {"context":"test (macos-latest, node 22)"},
  {"context":"test (macos-latest, node 24)"},
  {"context":"install smoke (npm i -g yields a working hgi)"},
  {"context":"binary e2e (linux-x64 single executable)"},
  {"context":"detect packaging changes"},
  {"context":"binary e2e (darwin-arm64)"},
  {"context":"dependency review (public repositories)"},
  {"context":"secret scan (gitleaks)"},
  {"context":"dependency audit and licenses"}
]'

main_ruleset="$(jq -n --argjson checks "$required_checks" '{
  name: "main protection", target: "branch", enforcement: "active",
  conditions: {ref_name: {include: ["~DEFAULT_BRANCH"], exclude: []}},
  bypass_actors: [],
  rules: [
    {type: "deletion"},
    {type: "non_fast_forward"},
    {type: "pull_request", parameters: {
      required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true, require_last_push_approval: true,
      required_review_thread_resolution: true}},
    {type: "required_status_checks", parameters: {
      strict_required_status_checks_policy: true, required_status_checks: $checks}}
  ]}')"

# RepositoryRole actor ids (built-in roles): read=1, write=2, triage=3, maintain=4, admin=5.
# A bypass for `maintain` also covers admins.
tag_ruleset="$(jq -n '{
  name: "release tags", target: "tag", enforcement: "active",
  conditions: {ref_name: {include: ["refs/tags/v*"], exclude: []}},
  bypass_actors: [{actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always"}],
  rules: [{type: "creation"}, {type: "update"}, {type: "deletion"}]}')"

run() { # <description> <gh api args...>
  local what="$1"; shift
  if $apply; then echo "applying: $what"; gh api "$@" >/dev/null; else echo "[dry run] $what"; fi
}

upsert_ruleset() { # <name> <json>
  local name="$1" body="$2" id
  id="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null || true)"
  [[ "$id" =~ ^[0-9]+$ ]] || id=""
  if [ -n "$id" ]; then
    run "update ruleset '$name' (#$id)" -X PUT "repos/$repo/rulesets/$id" --input - <<<"$body"
  else
    run "create ruleset '$name'" -X POST "repos/$repo/rulesets" --input - <<<"$body"
  fi
  $apply || printf '%s\n' "$body" | jq -c .
}

run "enable secret scanning and push protection" -X PATCH "repos/$repo" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
run "workflow token read-only by default; Actions cannot approve pull requests" -X PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
run "require approval before workflows run for all outside contributors" -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
run "enable Dependabot alerts" -X PUT "repos/$repo/vulnerability-alerts"
run "enable Dependabot security updates" -X PUT "repos/$repo/automated-security-fixes"
run "enable private vulnerability reporting" -X PUT "repos/$repo/private-vulnerability-reporting"

run "grant team '$team' the maintain role on $repo (needed to push v* tags)" -X PUT "orgs/$org/teams/$team/repos/$repo" -f permission=maintain

upsert_ruleset "main protection" "$main_ruleset"
upsert_ruleset "release tags" "$tag_ruleset"

# GitHub drops a team given as an environment reviewer on this plan (the list comes back empty), so the
# team's members are set as individual reviewers.
member_ids="$(gh api "orgs/$org/teams/$team/members" --paginate --jq '.[].id')"
reviewers_json="$(printf '%s\n' "$member_ids" | jq -Rn '[inputs | select(length > 0) | {type: "User", id: (. | tonumber)}]')"
run "create/update environment 'release' (reviewers: members of $team, self-review forbidden)" -X PUT "repos/$repo/environments/release" --input - <<<"$(jq -n --argjson reviewers "$reviewers_json" '{
  reviewers: $reviewers, prevent_self_review: true,
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}')"
policy_jq='.branch_policies[] | "\(.id) \(.type) \(.name)"'
if $apply; then
  # No error swallowing when applying: a failed listing must stop the run, not skip the cleanup.
  policies="$(gh api --paginate "repos/$repo/environments/release/deployment-branch-policies" --jq "$policy_jq")"
else
  policies="$(gh api "repos/$repo/environments/release/deployment-branch-policies" --jq "$policy_jq" 2>/dev/null | grep -E '^[0-9]+ (branch|tag) ' || true)"
fi
has_tag_policy=false
while read -r id type name; do
  [ -n "${id:-}" ] || continue
  if [ "$type" = tag ] && [ "$name" = 'v*' ]; then has_tag_policy=true; continue; fi
  run "remove stray deployment policy '$type $name' from environment 'release'" -X DELETE "repos/$repo/environments/release/deployment-branch-policies/$id"
done <<<"$policies"
$has_tag_policy || run "restrict environment 'release' deployments to tags matching v*" -X POST "repos/$repo/environments/release/deployment-branch-policies" -f name='v*' -f type=tag

$apply || echo "dry run only; re-run with --apply once the repository is public"
