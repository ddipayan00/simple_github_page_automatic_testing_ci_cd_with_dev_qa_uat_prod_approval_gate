#!/usr/bin/env bash
# One-time GitHub setup, run locally with the gh CLI right after the first push of main:
#   1. creates the dev / qa / uat / prod environments
#   2. makes YOU a required reviewer on the gated ones: this is the approval gate
#   3. creates the gh-pages branch (if missing) and turns on GitHub Pages from it
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
