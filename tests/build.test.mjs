// Tests for scripts/build.mjs: one build per environment with the right env.js.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build, envModuleSource, parseEnvModule } from "../scripts/build.mjs";
import { ENVIRONMENTS } from "../site/app.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const tmp = mkdtempSync(join(tmpdir(), "build-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("build", () => {
  for (const { name } of ENVIRONMENTS) {
    it(`builds ${name} with its own env.js`, async () => {
      const out = join(tmp, name);
      await build({ env: name, sha: SHA, repo: "octo/site", out, builtAt: "2026-11-17T10:00:00.000Z" });

      const { ENV } = await import(pathToFileURL(join(out, "env.js")).href);
      assert.deepEqual({ ...ENV }, { name, sha: SHA, repo: "octo/site", builtAt: "2026-11-17T10:00:00.000Z" });
      assert.ok(Object.isFrozen(ENV));
    });
  }

  it("copies every site file", async () => {
    const out = join(tmp, "copy");
    await build({ env: "dev", out });
    const files = readdirSync(out).sort();
    assert.deepEqual(files, ["app.js", "env.js", "index.html", "styles.css"]);
  });

  it("replaces stale files from a previous build", async () => {
    const out = join(tmp, "stale");
    await build({ env: "dev", out });
    spawnSync("touch", [join(out, "old.txt")]);
    await build({ env: "qa", out });
    assert.equal(existsSync(join(out, "old.txt")), false);
  });

  it("rejects an unknown environment", async () => {
    await assert.rejects(build({ env: "staging", out: join(tmp, "x") }), /Unknown environment "staging"/);
  });

  it("rejects an invalid commit SHA", async () => {
    await assert.rejects(build({ env: "dev", sha: "main; rm -rf /", out: join(tmp, "y") }), /Invalid commit SHA/);
  });

  it("rejects an invalid repository name", async () => {
    await assert.rejects(build({ env: "dev", repo: "not a repo", out: join(tmp, "r") }), /Invalid repository/);
  });

  it("CLI takes the repository from GITHUB_REPOSITORY, as set by GitHub Actions", async () => {
    const out = join(tmp, "cli-repo");
    const result = spawnSync(process.execPath, ["scripts/build.mjs", "--env", "dev", "--out", out], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "octo/site" },
    });
    assert.equal(result.status, 0, result.stderr);
    const { ENV } = await import(pathToFileURL(join(out, "env.js")).href);
    assert.equal(ENV.repo, "octo/site");
  });

  it("CLI exits non-zero for an unknown environment", () => {
    const result = spawnSync(process.execPath, ["scripts/build.mjs", "--env", "staging", "--out", join(tmp, "z")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown environment/);
  });
});

describe("env.js format", () => {
  it("round-trips through envModuleSource / parseEnvModule", () => {
    const config = { name: "prod", sha: SHA, repo: "octo/site", builtAt: "2026-11-17T10:00:00.000Z" };
    assert.deepEqual(parseEnvModule(envModuleSource(config)), config);
  });

  it("fails clearly on garbage", () => {
    assert.throws(() => parseEnvModule("<html>404</html>"), /does not contain an ENV object/);
  });
});
