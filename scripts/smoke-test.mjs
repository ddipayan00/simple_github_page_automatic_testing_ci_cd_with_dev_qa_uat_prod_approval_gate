#!/usr/bin/env node
// Post-deploy smoke test. Waits until GitHub Pages serves *this* commit for the
// target environment (Pages takes ~1 min to publish), then checks the page and assets.
//
//   node scripts/smoke-test.mjs --url https://you.github.io/repo/dev/ --env dev --sha <commit>
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseEnvModule } from "./build.mjs";

async function get(base, path, fetchImpl) {
  const url = new URL(path, base);
  url.searchParams.set("cb", Date.now()); // bypass the Pages CDN cache
  const res = await fetchImpl(url, { headers: { "cache-control": "no-cache" } });
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
}

// One pass over the deployment. Returns a list of problems (empty = healthy).
export async function verifyDeployment({ url, env, sha, fetchImpl = fetch }) {
  const base = url.endsWith("/") ? url : `${url}/`;

  const envFile = await get(base, "env.js", fetchImpl);
  if (envFile.status !== 200) return [`env.js returned HTTP ${envFile.status}`];

  let deployed;
  try {
    deployed = parseEnvModule(envFile.body);
  } catch (error) {
    return [`env.js is unreadable: ${error.message}`];
  }
  const failures = [];
  if (deployed.name !== env) failures.push(`env.js says "${deployed.name}", expected "${env}"`);
  if (sha && deployed.sha !== sha) failures.push(`env.js has commit ${deployed.sha || "(none)"}, expected ${sha}`);
  if (failures.length) return failures;

  for (const asset of ["app.js", "styles.css"]) {
    const res = await get(base, asset, fetchImpl);
    if (res.status !== 200) failures.push(`${asset} returned HTTP ${res.status}`);
  }
  const index = await get(base, "", fetchImpl);
  if (index.status !== 200) failures.push(`index.html returned HTTP ${index.status}`);
  else if (!index.body.includes('id="env-badge"')) failures.push("index.html is missing the environment badge");
  return failures;
}

export async function waitForDeployment({ timeoutMs = 360_000, intervalMs = 10_000, log = console.log, ...options }) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    let failures;
    try {
      failures = await verifyDeployment(options);
    } catch (error) {
      failures = [`request failed: ${error.message}`];
    }
    if (failures.length === 0) return { ok: true, attempt, failures };
    if (Date.now() + intervalMs > deadline) return { ok: false, attempt, failures };
    log(`Attempt ${attempt}: not live yet (${failures[0]})`);
    await sleep(intervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      env: { type: "string" },
      sha: { type: "string" },
      timeout: { type: "string", default: "360" },
    },
  });
  if (!values.url || !values.env) {
    console.error("Usage: smoke-test.mjs --url <page url> --env <env> [--sha <commit>] [--timeout <seconds>]");
    process.exit(2);
  }
  const result = await waitForDeployment({ ...values, timeoutMs: Number(values.timeout) * 1000 });
  if (result.ok) {
    console.log(`✔ ${values.env} is live at ${values.url} (attempt ${result.attempt})`);
  } else {
    console.error(`✘ Smoke test failed for ${values.env}:\n  - ${result.failures.join("\n  - ")}`);
    process.exit(1);
  }
}
