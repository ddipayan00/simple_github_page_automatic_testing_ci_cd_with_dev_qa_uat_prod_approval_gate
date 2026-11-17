# Simple GitHub Page: CI/CD with dev → qa → uat → prod and approval gates

A one-page static site that is tested automatically and promoted through four
environments on GitHub Pages. Everything after **dev** waits for your approval.

```
push to main
    │
    ▼
┌────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  Test  │──▶│   DEV    │──▶│  QA  🔒  │──▶│  UAT 🔒  │──▶│ PROD 🔒  │
└────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
 all tests    auto-deploy    you approve    you approve    you approve
              + smoke test   + smoke test   + smoke test   + smoke test
```

Pull requests run the **Test** job only; nothing is deployed from a PR.

## Live URLs

All four environments live side by side on the `gh-pages` branch:

| Environment | URL | Gate |
|---|---|---|
| landing | `https://<owner>.github.io/<repo>/` | – |
| dev | `https://<owner>.github.io/<repo>/dev/` | automatic |
| qa | `https://<owner>.github.io/<repo>/qa/` | approval |
| uat | `https://<owner>.github.io/<repo>/uat/` | approval |
| prod | `https://<owner>.github.io/<repo>/prod/` | approval |

Each page shows a coloured banner for its environment and the commit it was built from.

## How the approval gate works

Each deploy job runs inside a GitHub **environment** (`dev`, `qa`, `uat`, `prod`).
`scripts/setup-github.sh` adds you as a **required reviewer** on `qa`, `uat` and `prod`,
so when the pipeline reaches one of them it pauses and GitHub notifies you. Open
**Actions → the run → Review deployments**, tick the environment, and choose
**Approve and deploy** (or **Reject** to stop the release there).

To change which environments are gated, edit `GATED_ENVS` in `scripts/setup-github.sh`
and the `gated` flags in `site/app.js` (a test fails if they disagree), then re-run the script.

## Feature branch workflow (trunk-based)

`main` is the trunk and is protected: it only changes through a pull request, the
**Test** check must pass on a branch that is up to date with `main`, and PRs are
squash-merged (one commit per feature). Direct and force pushes are blocked.

```bash
git switch -c feature/my-change main     # short-lived: hours, not weeks
# ...commit...
git push -u origin feature/my-change
gh pr create --fill                      # Test runs on the PR (nothing deploys)
gh pr merge --squash --delete-branch     # once Test is green
```

If someone else merges first, your PR shows **out of date** and cannot merge until
you bring in the new `main` (`gh pr update-branch`) and Test passes again. That way
every commit on `main` was tested together with everything merged before it.

Each merge starts the pipeline. Merges close together are promoted as one release.
Rejecting at a gate stops that run only; to take a feature out, revert its squash
commit in a new PR.

## Latest commit wins

When several commits are merged in a row, you never have to approve or reject stale ones:

- **Supersede at each gate.** Just before a run reaches an environment, `scripts/supersede.mjs`
  cancels older runs that are still waiting for approval there (or queued behind it).
  The gate then shows only the newest commit, which contains every older one.
- **Other gates are left alone.** A commit waiting at prod is only replaced once a newer
  commit has itself passed uat, so frequent merges cannot keep restarting a release.
  Deploys already in progress are never cancelled.
- **Never backwards.** A deploy that finds a newer commit already live in its environment
  (e.g. you re-ran an old pipeline) publishes nothing, and that run stops there.
- **Landing page ships with prod only**, so an older deploy elsewhere cannot roll it back.

```
merge C1, then C2:   C1 ── waiting at UAT 🔒
                     C2 ── QA ✓ ── reaches UAT → C1 cancelled ("superseded by C2")
                     you approve C2 once: it carries C1 and C2
```

## Test cases

`npm test` runs all of these with Node's built-in test runner (no dependencies):

| File | What it checks |
|---|---|
| `tests/app.test.mjs` | page logic: environment order, which steps are gated, SHA/time formatting, titles, pipeline progress, DOM rendering |
| `tests/site.test.mjs` | HTML metadata (doctype, lang, viewport, title, description), every element the script needs exists once, all linked files exist, no `http://` links, one colour per environment, landing page links every env |
| `tests/build.test.mjs` | each environment builds with the correct `env.js`; stale files are removed; unknown envs and bad SHAs are rejected |
| `tests/smoke.test.mjs` | the post-deploy smoke test passes on a good deploy and fails on old commit, wrong env, unpublished site or missing asset; it retries while Pages is still publishing |
| `tests/deploy.test.mjs` | the gh-pages publisher, against a local bare repo: deploying one env never wipes another, an older commit never replaces a newer one, only prod publishes the landing page, history is never rewritten |
| `tests/supersede.test.mjs` | latest-commit-wins: cancels older runs waiting or queued at the same gate, never newer commits, other gates, or deploys in progress |
| `tests/pipeline.test.mjs` | the workflows: tests run before deploys, nothing deploys from PRs, promotion order is dev → qa → uat → prod, approval gates match the page, prod is always gated |

After every deploy, `scripts/smoke-test.mjs` also runs **against the live URL**: it
waits until GitHub Pages serves the new commit for that environment, then checks
that the page and its assets load. A failed smoke test stops the promotion.

## One-time setup

The repository must be **public** (approvals and Pages are free on public repos).

```bash
git push -u origin main          # first push starts the pipeline
scripts/setup-github.sh          # run right away: environments, approvals, Pages, main protection
```

The first push is safe to make before the setup: the dev deploy cannot pass its
smoke test until Pages is on, so the run cannot reach `qa` before the approval
gates exist.

## Local development

```bash
npm test                         # run every test
npm run preview                  # http://localhost:8080 (local preview)
node scripts/build.mjs --env uat --out dist   # build one environment
```

## Files

```
site/                     the page (index.html, styles.css, app.js, env.js)
hub/index.html            landing page at the gh-pages root
scripts/build.mjs         builds the site for one environment
scripts/deploy-gh-pages.sh   publishes a build into gh-pages/<env>/
scripts/smoke-test.mjs    post-deploy check against the live URL
scripts/supersede.mjs     cancels older runs waiting at a gate (latest commit wins)
scripts/setup-github.sh   one-time setup: environments, approval gates, Pages, main protection
.github/workflows/ci-cd.yml  the pipeline
.github/workflows/deploy.yml reusable deploy job (build → publish → smoke test)
tests/                    the test cases
```
