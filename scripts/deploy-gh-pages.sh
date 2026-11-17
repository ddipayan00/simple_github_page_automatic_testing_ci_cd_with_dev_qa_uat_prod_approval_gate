#!/usr/bin/env bash
# Publishes a built site into its own folder on the gh-pages branch
# (gh-pages/dev, gh-pages/qa, ...) without touching the other environments.
# Never force-pushes: if another job pushed first, it re-clones and retries.
#
#   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo scripts/deploy-gh-pages.sh <build-dir> <env>
#
# DEPLOY_REMOTE overrides the target remote (used by the tests with a local bare repo).
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <build-dir> <dev|qa|uat|prod>" >&2
  exit 2
fi

SRC_DIR="$(cd "$1" && pwd)"
TARGET="$2"
BRANCH="gh-pages"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

  rm -rf "./$TARGET"
  mkdir -p "./$TARGET"
  cp -R "$SRC_DIR/." "./$TARGET/"
  cp "$ROOT/hub/index.html" ./index.html   # landing page linking every environment
  touch .nojekyll                           # serve files as-is, no Jekyll build

  git add -A
  if git diff --cached --quiet; then
    echo "Nothing to publish for $TARGET"
    exit 0
  fi
  git commit --quiet -m "Deploy $TARGET from ${GITHUB_SHA:-local build}"

  if git push --quiet origin "$BRANCH"; then
    echo "Published $TARGET to $BRANCH (attempt $attempt)"
    exit 0
  fi
  echo "Push rejected (attempt $attempt), another deploy got there first; retrying" >&2
  sleep $((attempt * 3))
done

echo "Could not publish $TARGET after 5 attempts" >&2
exit 1
