// Tests for scripts/deploy-gh-pages.sh against a local bare git repo standing in for GitHub.
// The key property: deploying one environment never wipes another.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build, parseEnvModule } from "../scripts/build.mjs";

const tmp = mkdtempSync(join(tmpdir(), "deploy-test-"));
const remote = join(tmp, "remote.git");
const SHA_1 = "1111111111111111111111111111111111111111";
const SHA_2 = "2222222222222222222222222222222222222222";

after(() => rmSync(tmp, { recursive: true, force: true }));
before(() => execFileSync("git", ["init", "--quiet", "--bare", remote]));

async function deploy(env, sha) {
  const out = join(tmp, `dist-${env}-${sha.slice(0, 4)}`);
  await build({ env, sha, out });
  return spawnSync("bash", ["scripts/deploy-gh-pages.sh", out, env], {
    encoding: "utf8",
    env: { ...process.env, DEPLOY_REMOTE: remote, GITHUB_SHA: sha },
  });
}

const git = (...args) => execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8" });
const files = () => git("ls-tree", "-r", "--name-only", "gh-pages").trim().split("\n").sort();
const deployedEnv = (env) => parseEnvModule(git("show", `gh-pages:${env}/env.js`));

describe("deploy-gh-pages.sh", () => {
  it("creates gh-pages with the environment folder, landing page and .nojekyll", async () => {
    const result = await deploy("dev", SHA_1);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(files(), [
      ".nojekyll",
      "dev/app.js",
      "dev/env.js",
      "dev/index.html",
      "dev/styles.css",
      "index.html",
    ]);
  });

  it("adds a second environment next to the first", async () => {
    const result = await deploy("qa", SHA_1);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(files().includes("dev/index.html"));
    assert.ok(files().includes("qa/index.html"));
    assert.equal(deployedEnv("qa").name, "qa");
  });

  it("redeploying dev leaves qa untouched", async () => {
    const result = await deploy("dev", SHA_2);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(deployedEnv("dev").sha, SHA_2);
    assert.equal(deployedEnv("qa").sha, SHA_1);
  });

  it("never rewrites history (each deploy is a new commit)", () => {
    const log = git("log", "--format=%s", "gh-pages").trim().split("\n");
    assert.deepEqual(log, [`Deploy dev from ${SHA_2}`, `Deploy qa from ${SHA_1}`, `Deploy dev from ${SHA_1}`]);
  });

  it("rejects an unknown environment", () => {
    const result = spawnSync("bash", ["scripts/deploy-gh-pages.sh", tmp, "staging"], {
      encoding: "utf8",
      env: { ...process.env, DEPLOY_REMOTE: remote },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown environment: staging/);
  });
});
