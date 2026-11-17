// Tests for scripts/supersede.mjs ("latest commit wins" at each approval gate)
// against a fake GitHub API. Commits are made in the order C1 → C2 → C3 → C4.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubApi, supersede } from "../scripts/supersede.mjs";

const [C1, C2, C3, C4] = ["1", "2", "3", "4"].map((c) => c.repeat(40));
const ORDER = [C1, C2, C3, C4];
const isAncestor = (older, newer) => ORDER.indexOf(older) <= ORDER.indexOf(newer);
const CURRENT = { id: 300, workflow_id: 7, head_branch: "main", head_sha: C3 };

// runs: [{ id, sha, status, jobs: { "<job name>": "<job status>" } }]
function fakeGitHub(runs) {
  const calls = [];
  const api = async (path, { method = "GET" } = {}) => {
    calls.push(`${method} ${path}`);
    if (path === "repos/o/r/actions/runs/300") return CURRENT;
    const list = /^repos\/o\/r\/actions\/workflows\/7\/runs\?status=(\w+)&branch=main&per_page=100$/.exec(path);
    if (list) {
      return {
        workflow_runs: runs.filter((r) => r.status === list[1]).map((r) => ({ id: r.id, head_sha: r.sha })),
      };
    }
    const jobs = /^repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (jobs) {
      const run = runs.find((r) => r.id === Number(jobs[1]));
      return { jobs: Object.entries(run.jobs).map(([name, status]) => ({ name, status })) };
    }
    if (method === "POST" && /\/cancel$/.test(path)) return null;
    throw new Error(`unexpected call: ${method} ${path}`);
  };
  const cancelled = () => calls.filter((c) => c.startsWith("POST")).map((c) => Number(c.split("/").at(-2)));
  return { api, calls, cancelled };
}

const run = (options) => supersede({ env: "uat", repo: "o/r", runId: "300", sha: C3, isAncestor, log: () => {}, ...options });

describe("supersede", () => {
  it("cancels an older run waiting for approval at the same gate", async () => {
    const gh = fakeGitHub([{ id: 100, sha: C1, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } }]);
    const result = await run({ api: gh.api });
    assert.deepEqual(result, [{ id: 100, sha: C1, state: "waiting" }]);
    assert.deepEqual(gh.cancelled(), [100]);
  });

  it("cancels the run queued behind the gate before the one waiting at it", async () => {
    const gh = fakeGitHub([
      { id: 100, sha: C1, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } },
      { id: 200, sha: C2, status: "pending", jobs: { "UAT / Deploy to uat": "pending" } },
    ]);
    await run({ api: gh.api });
    // otherwise the queued run would grab the gate the moment the waiting one is cancelled
    assert.deepEqual(gh.cancelled(), [200, 100]);
  });

  it("leaves older runs that are waiting at a different gate", async () => {
    const gh = fakeGitHub([
      { id: 100, sha: C1, status: "waiting", jobs: { "UAT / Deploy to uat": "success", "Prod / Deploy to prod": "waiting" } },
    ]);
    assert.deepEqual(await run({ api: gh.api }), []);
    assert.deepEqual(gh.cancelled(), []);
  });

  it("never cancels a newer commit", async () => {
    const gh = fakeGitHub([{ id: 400, sha: C4, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } }]);
    assert.deepEqual(await run({ api: gh.api }), []);
    assert.deepEqual(gh.cancelled(), []);
  });

  it("never cancels an older run that is already deploying", async () => {
    const gh = fakeGitHub([{ id: 100, sha: C1, status: "waiting", jobs: { "UAT / Deploy to uat": "in_progress" } }]);
    assert.deepEqual(await run({ api: gh.api }), []);
  });

  it("ignores its own run and other runs of the same commit", async () => {
    const gh = fakeGitHub([
      { id: 300, sha: C3, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } },
      { id: 301, sha: C3, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } },
    ]);
    assert.deepEqual(await run({ api: gh.api }), []);
  });

  it("does not match a job that merely mentions the environment", async () => {
    const gh = fakeGitHub([{ id: 100, sha: C1, status: "waiting", jobs: { "UAT / Supersede older uat deploys": "waiting" } }]);
    assert.deepEqual(await run({ api: gh.api }), []);
  });

  it("dry run reports without cancelling", async () => {
    const gh = fakeGitHub([{ id: 100, sha: C1, status: "waiting", jobs: { "UAT / Deploy to uat": "waiting" } }]);
    const lines = [];
    const result = await run({ api: gh.api, dryRun: true, log: (line) => lines.push(line) });
    assert.equal(result.length, 1);
    assert.deepEqual(gh.cancelled(), []);
    assert.match(lines[0], /^Would cancel run 100 \(1111111, waiting at uat\): superseded by 3333333$/);
  });
});

describe("githubApi", () => {
  it("authenticates and parses JSON", async () => {
    let request;
    const api = githubApi({
      token: "t0k3n",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, text: async () => '{"id":1}' };
      },
    });
    assert.deepEqual(await api("repos/o/r"), { id: 1 });
    assert.equal(request.url, "https://api.github.com/repos/o/r");
    assert.equal(request.init.headers.authorization, "Bearer t0k3n");
  });

  it("returns null for an empty body and throws on HTTP errors", async () => {
    const respond = (status, body) => githubApi({ token: "t", fetchImpl: async () => ({ ok: status < 400, status, text: async () => body }) });
    assert.equal(await respond(202, "")("x", { method: "POST" }), null);
    await assert.rejects(respond(403, "{}")("repos/o/r/actions/runs/1/cancel", { method: "POST" }), /HTTP 403/);
  });
});
