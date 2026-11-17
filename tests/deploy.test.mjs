// Tests for scripts/deploy-gh-pages.sh against a local bare git repo standing in for
// GitHub. Key properties: deploying one environment never wipes another, an older
// commit never replaces a newer one, and only prod publishes the landing page.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build, parseEnvModule } from "../scripts/build.mjs";

const tmp = mkdtempSync(join(tmpdir(), "deploy-test-"));
const remote = join(tmp, "remote.git");
const history = join(tmp, "history"); // stands in for main: C1 → C2 → C3
let C1, C2, C3;

after(() => rmSync(tmp, { recursive: true, force: true }));
before(() => {
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["init", "--quiet", history]);
  const commit = (message) => {
    execFileSync("git", ["-C", history, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--allow-empty", "-m", message]);
    return execFileSync("git", ["-C", history, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  [C1, C2, C3] = [commit("c1"), commit("c2"), commit("c3")];
});

let deploys = 0;
async function deploy(env, sha) {
  const out = join(tmp, `dist-${++deploys}`);
  const outputFile = join(tmp, `output-${deploys}`);
  writeFileSync(outputFile, "");
  await build({ env, sha, out });
  const result = spawnSync("bash", ["scripts/deploy-gh-pages.sh", out, env], {
    encoding: "utf8",
    env: { ...process.env, DEPLOY_REMOTE: remote, DEPLOY_HISTORY_DIR: history, GITHUB_SHA: sha, GITHUB_OUTPUT: outputFile },
  });
  return { ...result, output: readFileSync(outputFile, "utf8").trim() };
}

const git = (...args) => execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8" });
const files = () => git("ls-tree", "-r", "--name-only", "gh-pages").trim().split("\n").sort();
const liveSha = (env) => parseEnvModule(git("show", `gh-pages:${env}/env.js`)).sha;

describe("deploy-gh-pages.sh", () => {
  it("creates gh-pages with the environment folder and .nojekyll", async () => {
    const result = await deploy("dev", C1);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "published=true");
    assert.deepEqual(files(), [".nojekyll", "dev/app.js", "dev/env.js", "dev/index.html", "dev/styles.css"]);
  });

  it("adds a second environment next to the first", async () => {
    const result = await deploy("qa", C1);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(files().includes("dev/index.html"));
    assert.ok(files().includes("qa/index.html"));
  });

  it("redeploying dev with a newer commit leaves qa untouched", async () => {
    const result = await deploy("dev", C2);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(liveSha("dev"), C2);
    assert.equal(liveSha("qa"), C1);
  });

  it("refuses to replace a newer commit with an older one", async () => {
    const result = await deploy("dev", C1);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "published=false");
    assert.match(result.stdout, /Skipped dev: it already runs [0-9a-f]{7}, which is newer than [0-9a-f]{7}/);
    assert.equal(liveSha("dev"), C2);
  });

  it("allows redeploying the commit that is already live", async () => {
    const result = await deploy("dev", C2);
    assert.equal(result.output, "published=true");
    assert.equal(liveSha("dev"), C2);
  });

  it("publishes the landing page only with prod", async () => {
    assert.equal(files().includes("index.html"), false, "dev and qa deploys must not publish the landing page");
    const result = await deploy("prod", C3);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(files().includes("index.html"));
    assert.match(git("show", "gh-pages:index.html"), /<title>Environments/);
  });

  it("never rewrites history (each deploy is a new commit; the skipped one made none)", () => {
    const log = git("log", "--format=%s", "gh-pages").trim().split("\n");
    assert.deepEqual(log, [
      `Deploy prod from ${C3}`,
      `Deploy dev from ${C2}`,
      `Deploy dev from ${C2}`,
      `Deploy qa from ${C1}`,
      `Deploy dev from ${C1}`,
    ]);
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
