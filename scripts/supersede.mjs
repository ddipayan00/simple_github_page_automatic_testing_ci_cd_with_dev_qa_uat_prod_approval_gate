#!/usr/bin/env node
// "Latest commit wins" at every approval gate.
//
// Runs just before this pipeline run reaches <env>'s deploy job. Any OLDER run of
// the same workflow (its commit is an ancestor of ours) that is still waiting for
// approval at <env>, or queued behind that gate, is cancelled. The gate then offers
// the newest commit instead of making you approve or reject stale ones first.
//
// Runs waiting at OTHER gates are left alone: a release candidate waiting at prod
// is only replaced once a newer commit has itself passed uat. Cancelling everything
// on every merge would restart the release each time, and prod would never ship.
//
//   GITHUB_TOKEN=... node scripts/supersede.mjs --env uat [--dry-run]
//   (--run-id, --sha and --repo default to GITHUB_RUN_ID, GITHUB_SHA, GITHUB_REPOSITORY)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Job states that mean "not deploying yet": waiting = held at the approval gate,
// pending = queued behind another run at the gate. A queued/in-progress job is
// already approved and deploying, so it is never cancelled.
const STALE_JOB_STATES = ["pending", "waiting"];

export function gitIsAncestor(older, newer) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], { stdio: "ignore" });
    return true;
  } catch {
    return false; // not an ancestor, or a commit we don't know: never cancel on doubt
  }
}

export function githubApi({ token, baseUrl = "https://api.github.com", fetchImpl = fetch }) {
  return async (path, { method = "GET" } = {}) => {
    const res = await fetchImpl(`${baseUrl}/${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`${method} ${path} returned HTTP ${res.status}`);
    const body = await res.text();
    return body ? JSON.parse(body) : null;
  };
}

export async function supersede({ env, repo, runId, sha, api, isAncestor = gitIsAncestor, dryRun = false, log = console.log }) {
  const current = await api(`repos/${repo}/actions/runs/${runId}`);
  const runsUrl = `repos/${repo}/actions/workflows/${current.workflow_id}/runs`;
  const branch = encodeURIComponent(current.head_branch);

  const candidates = new Map();
  for (const status of STALE_JOB_STATES) {
    const { workflow_runs: runs } = await api(`${runsUrl}?status=${status}&branch=${branch}&per_page=100`);
    for (const run of runs) candidates.set(run.id, run);
  }

  const stale = [];
  for (const run of candidates.values()) {
    if (run.id === current.id || run.head_sha === sha) continue;
    if (!isAncestor(run.head_sha, sha)) continue; // only commits older than ours
    const { jobs } = await api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const gateJob = jobs.find((job) => job.name.endsWith(`Deploy to ${env}`) && STALE_JOB_STATES.includes(job.status));
    if (gateJob) stale.push({ id: run.id, sha: run.head_sha, state: gateJob.status });
  }

  // Cancel queued runs first, so none of them grabs the gate when the waiting one goes.
  stale.sort((a, b) => STALE_JOB_STATES.indexOf(a.state) - STALE_JOB_STATES.indexOf(b.state));
  for (const run of stale) {
    if (!dryRun) await api(`repos/${repo}/actions/runs/${run.id}/cancel`, { method: "POST" });
    log(`${dryRun ? "Would cancel" : "Cancelled"} run ${run.id} (${run.sha.slice(0, 7)}, ${run.state} at ${env}): superseded by ${sha.slice(0, 7)}`);
  }
  if (stale.length === 0) log(`No older run is waiting at ${env}`);
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      env: { type: "string", default: "" },
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "" },
      "run-id": { type: "string", default: process.env.GITHUB_RUN_ID ?? "" },
      sha: { type: "string", default: process.env.GITHUB_SHA ?? "" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!values.env || !values.repo || !values["run-id"] || !values.sha || !token) {
    console.error("Usage: GITHUB_TOKEN=... supersede.mjs --env <env> [--repo o/r] [--run-id id] [--sha commit] [--dry-run]");
    process.exit(2);
  }
  try {
    await supersede({
      env: values.env,
      repo: values.repo,
      runId: values["run-id"],
      sha: values.sha,
      dryRun: values["dry-run"],
      api: githubApi({ token, baseUrl: process.env.GITHUB_API_URL || undefined }),
    });
  } catch (error) {
    // Housekeeping must never block a deploy: worst case the old run stays queued.
    console.log(`::warning::Could not cancel older ${values.env} deploys: ${error.message}`);
  }
}
