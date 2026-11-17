import { ENV } from "./env.js";

// Promotion order. `gated` is display-only: the real approval gate is the
// required-reviewer rule on the GitHub environment (scripts/setup-github.sh).
export const ENVIRONMENTS = Object.freeze([
  { name: "dev", label: "Development", gated: false, purpose: "Latest main, deployed on every merge" },
  { name: "qa", label: "QA", gated: true, purpose: "Testing by the QA team" },
  { name: "uat", label: "UAT", gated: true, purpose: "Business sign-off before release" },
  { name: "prod", label: "Production", gated: true, purpose: "Live for everyone" },
]);

// Elements render() fills in; tests check index.html provides all of them.
export const ELEMENT_IDS = Object.freeze(["env-badge", "purpose", "title", "commit", "built-at", "pipeline"]);

export function findEnvironment(name) {
  return ENVIRONMENTS.find((env) => env.name === name) ?? null;
}

export function shortSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : "local";
}

export function formatBuildTime(iso) {
  const date = new Date(iso ?? "");
  if (!iso || Number.isNaN(date.getTime())) return "not built";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function commitUrl(env) {
  const { repo, sha } = env ?? {};
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  return `https://github.com/${repo}/commit/${sha}`;
}

export function pageTitle(env) {
  const current = findEnvironment(env?.name);
  return `Hello from ${current ? current.label : "local"}`;
}

export function pipelineSteps(currentName) {
  const index = ENVIRONMENTS.findIndex((env) => env.name === currentName);
  return ENVIRONMENTS.map((env, i) => ({
    ...env,
    state: index === -1 || i > index ? "pending" : i < index ? "done" : "current",
  }));
}

export function render(doc, env) {
  const current = findEnvironment(env?.name);
  const byId = (id) => doc.getElementById(id);

  doc.documentElement.dataset.env = current ? current.name : "local";
  doc.title = `${pageTitle(env)} · CI/CD demo`;
  byId("env-badge").textContent = current ? current.label : "Local preview";
  byId("purpose").textContent = current ? current.purpose : "Local preview, not deployed";
  byId("title").textContent = pageTitle(env);
  byId("commit").textContent = shortSha(env?.sha);
  byId("built-at").textContent = formatBuildTime(env?.builtAt);
  const url = commitUrl(env);
  if (url) byId("commit").setAttribute("href", url);

  const steps = pipelineSteps(current?.name).map((step) => {
    const li = doc.createElement("li");
    li.className = `step step--${step.state}`;
    li.textContent = step.name.toUpperCase();
    if (step.gated) li.dataset.gated = "true";
    if (step.state === "current") li.setAttribute("aria-current", "step");
    return li;
  });
  byId("pipeline").replaceChildren(...steps);
}

if (typeof document !== "undefined") render(document, ENV);
