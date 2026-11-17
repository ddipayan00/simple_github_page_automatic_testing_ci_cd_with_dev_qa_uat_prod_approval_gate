#!/usr/bin/env bash
# Publishes a built site into its own folder on the gh-pages branch
# (gh-pages/dev, gh-pages/qa, ...) without touching the other environments.
# Never force-pushes: if another job pushed first, it re-clones and retries.
# Never goes backwards: if the environment already runs a newer commit than
# GITHUB_SHA, nothing is published (e.g. a re-run of an old pipeline).
#
#   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_SHA=... scripts/deploy-gh-pages.sh <build-dir> <env>
#
# Writes published=true|false to $GITHUB_OUTPUT when set.
# DEPLOY_REMOTE / DEPLOY_HISTORY_DIR override the target remote and the git history
# used to compare commits (the tests use a local bare repo and a scratch history).
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <build-dir> <dev|qa|uat|prod>" >&2
  exit 2
fi

SRC_DIR="$(cd "$1" && pwd)"
TARGET="$2"
BRANCH="gh-pages"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HISTORY_DIR="${DEPLOY_HISTORY_DIR:-$ROOT}"

set_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "published=$1" >> "$GITHUB_OUTPUT"; fi
}

case "$TARGET" in
  dev|qa|uat|prod) ;;
  *) echo "Unknown environment: $TARGET" >&2; exit 2 ;;
esac

if [[ -n "${DEPLOY_REMOTE:-}" ]]; then
  REMOTE="$DEPLOY_REMOTE"
else
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for attempt in 1 2 3 4 5; do
  cd "$ROOT"
  rm -rf "$WORK/repo"

  if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK/repo"
  else
    git init --quiet -b "$BRANCH" "$WORK/repo"
    git -C "$WORK/repo" remote add origin "$REMOTE"
  fi

  cd "$WORK/repo"
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git config commit.gpgsign false

  # Never replace a newer deploy with an older commit. Same commit = redeploy, fine.
  live_sha=""
  if [[ -f "./$TARGET/env.js" ]]; then
    live_sha="$(sed -n '/"sha"/{s/.*"sha": "\([0-9a-f]*\)".*/\1/p;q;}' "./$TARGET/env.js")"
  fi
  if [[ -n "$live_sha" && -n "${GITHUB_SHA:-}" && "$live_sha" != "$GITHUB_SHA" ]] &&
     git -C "$HISTORY_DIR" merge-base --is-ancestor "$GITHUB_SHA" "$live_sha" 2>/dev/null; then
    echo "Skipped $TARGET: it already runs ${live_sha:0:7}, which is newer than ${GITHUB_SHA:0:7}"
    set_output false
    exit 0
  fi

  rm -rf "./$TARGET"
  mkdir -p "./$TARGET"
  cp -R "$SRC_DIR/." "./$TARGET/"
  if [[ "$TARGET" == prod ]]; then
    # The landing page ships with prod only, so it passes every gate and an
    # older deploy to another environment can never roll it back.
    cp "$ROOT/hub/index.html" ./index.html
  fi
  touch .nojekyll                           # serve files as-is, no Jekyll build

  git add -A
  if git diff --cached --quiet; then
    echo "Nothing to publish for $TARGET"
    set_output true
    exit 0
  fi
  git commit --quiet -m "Deploy $TARGET from ${GITHUB_SHA:-local build}"

  if git push --quiet origin "$BRANCH"; then
    echo "Published $TARGET to $BRANCH (attempt $attempt)"
    set_output true
    exit 0
  fi
  echo "Push rejected (attempt $attempt), another deploy got there first; retrying" >&2
  sleep $((attempt * 3))
done

echo "Could not publish $TARGET after 5 attempts" >&2
exit 1
