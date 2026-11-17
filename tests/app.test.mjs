// Unit tests for the page logic in site/app.js.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ELEMENT_IDS,
  ENVIRONMENTS,
  commitUrl,
  findEnvironment,
  formatBuildTime,
  pageTitle,
  pipelineSteps,
  render,
  shortSha,
} from "../site/app.js";

function fakeDocument() {
  const element = () => ({
    textContent: "",
    className: "",
    dataset: {},
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...children) { this.children = children; },
  });
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, element()]));
  return {
    title: "",
    documentElement: element(),
    elements,
    getElementById: (id) => elements[id] ?? null,
    createElement: element,
  };
}

describe("environments", () => {
  it("promotes in the order dev → qa → uat → prod", () => {
    assert.deepEqual(ENVIRONMENTS.map((e) => e.name), ["dev", "qa", "uat", "prod"]);
  });

  it("only dev deploys without an approval", () => {
    assert.deepEqual(ENVIRONMENTS.filter((e) => !e.gated).map((e) => e.name), ["dev"]);
  });

  it("finds known environments and returns null for unknown ones", () => {
    assert.equal(findEnvironment("uat").label, "UAT");
    assert.equal(findEnvironment("staging"), null);
    assert.equal(findEnvironment(undefined), null);
  });
});

describe("shortSha", () => {
  it("shortens a full commit SHA to 7 characters", () => {
    assert.equal(shortSha("0123456789abcdef0123456789abcdef01234567"), "0123456");
  });

  it("falls back to 'local' for missing or invalid values", () => {
    for (const value of ["", undefined, null, "not-a-sha", "abc"]) assert.equal(shortSha(value), "local");
  });
});

describe("formatBuildTime", () => {
  it("formats an ISO timestamp as UTC minutes", () => {
    assert.equal(formatBuildTime("2026-11-17T09:30:45.000Z"), "2026-11-17 09:30 UTC");
  });

  it("reports 'not built' for missing or invalid timestamps", () => {
    for (const value of ["", undefined, "yesterday"]) assert.equal(formatBuildTime(value), "not built");
  });
});

describe("commitUrl", () => {
  it("links to the commit on GitHub", () => {
    assert.equal(commitUrl({ repo: "octo/site", sha: "abcdef1234567" }), "https://github.com/octo/site/commit/abcdef1234567");
  });

  it("returns null when the repo or commit is missing or invalid", () => {
    assert.equal(commitUrl({ repo: "", sha: "abcdef1234567" }), null);
    assert.equal(commitUrl({ repo: "octo/site", sha: "" }), null);
    assert.equal(commitUrl({ repo: "javascript:alert(1)//x", sha: "abcdef1234567" }), null);
    assert.equal(commitUrl(undefined), null);
  });
});

describe("pageTitle", () => {
  it("names the environment", () => {
    assert.equal(pageTitle({ name: "prod" }), "Hello from Production");
    assert.equal(pageTitle({ name: "qa" }), "Hello from QA");
  });

  it("falls back to local", () => {
    assert.equal(pageTitle({ name: "local" }), "Hello from local");
    assert.equal(pageTitle(undefined), "Hello from local");
  });
});

describe("pipelineSteps", () => {
  const states = (name) => pipelineSteps(name).map((s) => s.state);

  it("marks earlier environments done and later ones pending", () => {
    assert.deepEqual(states("qa"), ["done", "current", "pending", "pending"]);
    assert.deepEqual(states("prod"), ["done", "done", "done", "current"]);
    assert.deepEqual(states("dev"), ["current", "pending", "pending", "pending"]);
  });

  it("marks everything pending for a local preview", () => {
    assert.deepEqual(states("local"), ["pending", "pending", "pending", "pending"]);
  });
});

describe("render", () => {
  it("fills in the page for a deployed environment", () => {
    const doc = fakeDocument();
    render(doc, { name: "uat", sha: "abcdef1234567", repo: "octo/site", builtAt: "2026-11-17T08:00:00Z" });

    assert.equal(doc.documentElement.dataset.env, "uat");
    assert.equal(doc.title, "Hello from UAT · CI/CD demo");
    assert.equal(doc.elements["env-badge"].textContent, "UAT");
    assert.equal(doc.elements.title.textContent, "Hello from UAT");
    assert.equal(doc.elements.commit.textContent, "abcdef1");
    assert.equal(doc.elements["built-at"].textContent, "2026-11-17 08:00 UTC");
    assert.equal(doc.elements.commit.attributes.href, "https://github.com/octo/site/commit/abcdef1234567");

    const steps = doc.elements.pipeline.children;
    assert.deepEqual(steps.map((li) => li.textContent), ["DEV", "QA", "UAT", "PROD"]);
    assert.equal(steps[2].className, "step step--current");
    assert.equal(steps[2].attributes["aria-current"], "step");
    assert.deepEqual(steps.map((li) => li.dataset.gated === "true"), [false, true, true, true]);
  });

  it("shows a local preview when there is no environment", () => {
    const doc = fakeDocument();
    render(doc, { name: "local", sha: "", builtAt: "" });

    assert.equal(doc.documentElement.dataset.env, "local");
    assert.equal(doc.elements["env-badge"].textContent, "Local preview");
    assert.equal(doc.elements.commit.textContent, "local");
    assert.equal(doc.elements["built-at"].textContent, "not built");
    assert.equal(doc.elements.commit.attributes.href, undefined, "a local preview has nothing to link to");
  });
});
