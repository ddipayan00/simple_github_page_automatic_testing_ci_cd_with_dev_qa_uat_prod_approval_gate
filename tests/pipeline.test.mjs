// Guards the CI/CD configuration itself: promotion order, approval gates, and
// that nothing deploys from a pull request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ENVIRONMENTS } from "../site/app.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pipeline = read(".github/workflows/ci-cd.yml");
const deploy = read(".github/workflows/deploy.yml");
const setup = read("scripts/setup-github.sh");

// Text of one top-level job (2-space indented key) in a workflow file.
function job(yaml, name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job "${name}" not found`);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe("ci-cd.yml", () => {
  it("runs on pull requests and on pushes to main", () => {
    assert.match(pipeline, /pull_request:\s*\n\s*branches: \[main\]/);
    assert.match(pipeline, /push:\s*\n\s*branches: \[main\]/);
  });

  it("runs the test suite before anything is deployed", () => {
    assert.match(job(pipeline, "test"), /run: npm test/);
    assert.match(job(pipeline, "deploy-dev"), /needs: test/);
  });

  it("never deploys from a pull request or another branch", () => {
    const dev = job(pipeline, "deploy-dev");
    assert.match(dev, /if: .*github\.event_name != 'pull_request'/);
    assert.match(dev, /if: .*github\.ref == 'refs\/heads\/main'/);
  });

  it("promotes dev → qa → uat → prod, each waiting for the previous one", () => {
    ENVIRONMENTS.forEach(({ name }, i) => {
      const block = job(pipeline, `deploy-${name}`);
      assert.match(block, new RegExp(`environment: ${name}\\n`), `deploy-${name} targets the wrong environment`);
      assert.match(block, /uses: \.\/\.github\/workflows\/deploy\.yml/);
      assert.match(block, /contents: write/);
      assert.match(block, /actions: write/, `deploy-${name} cannot cancel superseded runs`);
      if (i > 0) assert.match(block, new RegExp(`needs: deploy-${ENVIRONMENTS[i - 1].name}\\n`));
    });
  });

  it("stops promoting a commit once a newer one was already live", () => {
    ENVIRONMENTS.slice(1).forEach(({ name }, i) => {
      const prev = ENVIRONMENTS[i].name;
      assert.match(job(pipeline, `deploy-${name}`), new RegExp(`if: needs\\.deploy-${prev}\\.outputs\\.published == 'true'`));
    });
  });
});

describe("deploy.yml", () => {
  it("runs inside the GitHub environment, so its approval rules apply", () => {
    assert.match(deploy, /environment:\s*\n\s*name: \$\{\{ inputs\.environment \}\}/);
  });

  it("builds, publishes, then smoke-tests the live URL", () => {
    const steps = ["scripts/build.mjs", "scripts/deploy-gh-pages.sh", "scripts/smoke-test.mjs"];
    const positions = steps.map((s) => deploy.indexOf(s));
    positions.forEach((p, i) => assert.notEqual(p, -1, `${steps[i]} is not run`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "steps are out of order");
  });

  it("never runs two deploys to the same environment at once", () => {
    assert.match(deploy, /group: deploy-\$\{\{ inputs\.environment \}\}\n\s*cancel-in-progress: false/);
  });

  it("cancels older runs waiting at the gate before this run enters it", () => {
    const supersede = job(deploy, "supersede");
    assert.match(supersede, /run: node scripts\/supersede\.mjs --env "\$TARGET_ENV"/);
    assert.match(supersede, /actions: write/);
    assert.match(supersede, /fetch-depth: 0/);
    assert.doesNotMatch(supersede, /environment:\s*\n\s*name:/, "supersede must run before the gate, not behind it");
    assert.match(job(deploy, "deploy"), /needs: supersede\n/);
  });

  it("has the full history it needs to compare commits, and only smoke-tests what it published", () => {
    const deployJob = job(deploy, "deploy");
    assert.match(deployJob, /fetch-depth: 0/);
    assert.match(deployJob, /id: publish\n/);
    assert.match(deployJob, /published: \$\{\{ steps\.publish\.outputs\.published \}\}/);
    assert.match(deployJob, /- name: Smoke test live site\n\s*if: steps\.publish\.outputs\.published == 'true'/);
    assert.match(deploy, /value: \$\{\{ jobs\.deploy\.outputs\.published \}\}/);
  });
});

describe("approval gates", () => {
  it("setup-github.sh gates exactly the environments the page shows as gated", () => {
    const gated = /^GATED_ENVS="([^"]*)"/m.exec(setup)?.[1].split(/\s+/);
    const all = /^ALL_ENVS="([^"]*)"/m.exec(setup)?.[1].split(/\s+/);
    assert.deepEqual(all, ENVIRONMENTS.map((e) => e.name));
    assert.deepEqual(gated, ENVIRONMENTS.filter((e) => e.gated).map((e) => e.name));
  });

  it("branch protection requires the check that ci-cd.yml actually produces", () => {
    const required = /^REQUIRED_CHECK="([^"]+)"/m.exec(setup)?.[1];
    assert.ok(required, "REQUIRED_CHECK not found in setup-github.sh");
    // If these drift apart, every PR would wait forever for a check that never runs.
    assert.match(job(pipeline, "test"), new RegExp(`\\n {4}name: ${required}\\n`));
  });

  it("production always requires approval", () => {
    assert.equal(ENVIRONMENTS.find((e) => e.name === "prod").gated, true);
  });
});
