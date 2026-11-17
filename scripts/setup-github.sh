#!/usr/bin/env bash
# One-time GitHub setup, run locally with the gh CLI right after the first push of main:
#   1. creates the dev / qa / uat / prod environments
#   2. makes YOU a required reviewer on the gated ones: this is the approval gate
#   3. creates the gh-pages branch (if missing) and turns on GitHub Pages from it
#   4. protects main for trunk-based development (PR + passing, up-to-date tests)
# Safe to re-run: every step is idempotent.
#
#   scripts/setup-github.sh [owner/repo] [reviewer-login]
set -euo pipefail

ALL_ENVS="dev qa uat prod"
GATED_ENVS="qa uat prod"   # keep in sync with ENVIRONMENTS in site/app.js (a test checks this)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
REVIEWER="${2:-$(gh api user -q .login)}"
REVIEWER_ID="$(gh api "users/$REVIEWER" -q .id)"

echo "Repository: $REPO"
echo "Approver:   @$REVIEWER"
echo

# 1 + 2. Environments and approval gates
for env in $ALL_ENVS; do
  if [[ " $GATED_ENVS " == *" $env "* ]]; then
    body="{\"reviewers\":[{\"type\":\"User\",\"id\":$REVIEWER_ID}],\"prevent_self_review\":false}"
    note="waits for approval from @$REVIEWER"
  else
    body='{"reviewers":[]}'
    note="deploys automatically"
  fi
  gh api -X PUT "repos/$REPO/environments/$env" --input - --silent <<<"$body"
  echo "✔ environment $env: $note"
done

# 3a. gh-pages branch (Pages can only be enabled once the branch exists)
if gh api "repos/$REPO/branches/gh-pages" --silent 2>/dev/null; then
  echo "✔ gh-pages branch already exists"
else
  tree_json="$(node -e '
    const fs = require("fs");
    const file = (path, content) => ({ path, mode: "100644", type: "blob", content });
    console.log(JSON.stringify({ tree: [file("index.html", fs.readFileSync(process.argv[1], "utf8")), file(".nojekyll", "\n")] }));
  ' "$ROOT/hub/index.html")"
  tree_sha="$(gh api "repos/$REPO/git/trees" --input - -q .sha <<<"$tree_json")"
  commit_sha="$(gh api "repos/$REPO/git/commits" -f message="Initialize gh-pages" -f tree="$tree_sha" -q .sha)"
  # A deploy job may have created the branch meanwhile; that is fine too.
  gh api "repos/$REPO/git/refs" -f ref=refs/heads/gh-pages -f sha="$commit_sha" --silent 2>/dev/null \
    || gh api "repos/$REPO/branches/gh-pages" --silent
  echo "✔ gh-pages branch created"
fi

# 3b. GitHub Pages, served from the root of gh-pages
pages_body='{"build_type":"legacy","source":{"branch":"gh-pages","path":"/"}}'
if gh api "repos/$REPO/pages" --silent 2>/dev/null; then
  gh api -X PUT "repos/$REPO/pages" --input - --silent <<<"$pages_body"
else
  gh api -X POST "repos/$REPO/pages" --input - --silent <<<"$pages_body"
fi
owner="${REPO%%/*}"
echo "✔ GitHub Pages on: https://${owner,,}.github.io/${REPO#*/}/"

# 4. Trunk-based flow: main only changes through a squash-merged PR whose
#    "Test" check passed on top of the latest main (no direct or force pushes).
REQUIRED_CHECK="Test"   # must match the test job's name in ci-cd.yml (a test checks this)
RULESET_NAME="main: PR with passing tests"
ruleset="$(cat <<JSON
{
  "name": "$RULESET_NAME",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "$REQUIRED_CHECK", "integration_id": 15368 }] } }
  ]
}
JSON
)"
ruleset_id="$(gh api "repos/$REPO/rulesets" -q ".[] | select(.name == \"$RULESET_NAME\") | .id")"
if [[ -n "$ruleset_id" ]]; then
  gh api -X PUT "repos/$REPO/rulesets/$ruleset_id" --input - --silent <<<"$ruleset"
else
  gh api -X POST "repos/$REPO/rulesets" --input - --silent <<<"$ruleset"
fi
gh repo edit "$REPO" --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge >/dev/null
echo "✔ main protected: PR required, \"$REQUIRED_CHECK\" must pass on an up-to-date branch, squash merge only"
