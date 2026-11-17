// Tests for scripts/smoke-test.mjs against a fake "GitHub Pages" served from a local build.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "../scripts/build.mjs";
import { verifyDeployment, waitForDeployment } from "../scripts/smoke-test.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const URL_BASE = "https://example.github.io/repo/qa/";
const tmp = mkdtempSync(join(tmpdir(), "smoke-test-"));
const dist = join(tmp, "qa");

before(() => build({ env: "qa", sha: SHA, out: dist }));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Serves files from `dir` the way Pages would; `missing` simulates 404s.
function fakePages(dir, { missing = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const file = new URL(url).pathname.replace("/repo/qa/", "") || "index.html";
    calls.push(file);
    if (missing.includes(file)) return { status: 404, text: async () => "Not Found" };
    try {
      const body = readFileSync(join(dir, file), "utf8");
      return { status: 200, text: async () => body };
    } catch {
      return { status: 404, text: async () => "Not Found" };
    }
  };
  return { fetchImpl, calls };
}

describe("verifyDeployment", () => {
  it("passes when the expected commit is live", async () => {
    const { fetchImpl, calls } = fakePages(dist);
    assert.deepEqual(await verifyDeployment({ url: URL_BASE, env: "qa", sha: SHA, fetchImpl }), []);
    assert.deepEqual(calls.sort(), ["app.js", "env.js", "index.html", "styles.css"]);
  });

  it("works without a trailing slash on the URL", async () => {
    const { fetchImpl } = fakePages(dist);
    assert.deepEqual(await verifyDeployment({ url: URL_BASE.slice(0, -1), env: "qa", sha: SHA, fetchImpl }), []);
  });

  it("fails when an older commit is still being served", async () => {
    const { fetchImpl } = fakePages(dist);
    const failures = await verifyDeployment({ url: URL_BASE, env: "qa", sha: "1".repeat(40), fetchImpl });
    assert.match(failures[0], /expected 1111111/);
  });

  it("fails when the wrong environment is served", async () => {
    const { fetchImpl } = fakePages(dist);
    const failures = await verifyDeployment({ url: URL_BASE, env: "prod", sha: SHA, fetchImpl });
    assert.match(failures[0], /says "qa", expected "prod"/);
  });

  it("fails when the site is not published yet", async () => {
    const { fetchImpl } = fakePages(dist, { missing: ["env.js"] });
    assert.deepEqual(await verifyDeployment({ url: URL_BASE, env: "qa", sha: SHA, fetchImpl }), [
      "env.js returned HTTP 404",
    ]);
  });

  it("fails when an asset is missing", async () => {
    const { fetchImpl } = fakePages(dist, { missing: ["styles.css"] });
    assert.deepEqual(await verifyDeployment({ url: URL_BASE, env: "qa", sha: SHA, fetchImpl }), [
      "styles.css returned HTTP 404",
    ]);
  });
});

describe("waitForDeployment", () => {
  it("retries until GitHub Pages finishes publishing", async () => {
    let requests = 0;
    const live = fakePages(dist).fetchImpl;
    const fetchImpl = async (url) => (++requests <= 2 ? { status: 404, text: async () => "" } : live(url));

    const result = await waitForDeployment({ url: URL_BASE, env: "qa", sha: SHA, fetchImpl, intervalMs: 1, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.attempt, 3);
  });

  it("gives up after the timeout and reports why", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await waitForDeployment({ url: URL_BASE, env: "qa", sha: SHA, fetchImpl, timeoutMs: 0, intervalMs: 1, log: () => {} });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, ["request failed: ECONNREFUSED"]);
  });
});
