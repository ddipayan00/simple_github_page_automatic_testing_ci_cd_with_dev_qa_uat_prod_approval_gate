// Static checks on the HTML/CSS that ships to every environment.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ELEMENT_IDS, ENVIRONMENTS } from "../site/app.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SITE_DIR = new URL("../site/", import.meta.url).pathname;
const html = read("site/index.html");
const css = read("site/styles.css");
const hub = read("hub/index.html");

describe("index.html", () => {
  it("has the essential document metadata", () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en"/);
    assert.match(html, /<meta charset="utf-8">/i);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<title>[^<]+<\/title>/);
  });

  it("contains every element the script fills in, exactly once", () => {
    for (const id of ELEMENT_IDS) {
      const count = html.split(`id="${id}"`).length - 1;
      assert.equal(count, 1, `expected one element with id="${id}", found ${count}`);
    }
  });

  it("loads the app as an ES module", () => {
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  });

  it("only references local files that exist", () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((ref) => !/^(https?:|\.\.\/|#|mailto:)/.test(ref));
    assert.ok(local.length >= 2, "expected the stylesheet and script to be referenced");
    for (const ref of local) assert.ok(existsSync(join(SITE_DIR, ref)), `missing file: ${ref}`);
  });

  it("has no insecure http:// links", () => {
    assert.doesNotMatch(html, /(?:src|href)="http:\/\//);
  });
});

describe("styles.css", () => {
  it("gives every environment its own colour", () => {
    for (const { name } of ENVIRONMENTS) {
      assert.match(css, new RegExp(`\\[data-env="${name}"\\]\\s*\\{\\s*--accent:`), `no colour for ${name}`);
    }
  });
});

describe("hub/index.html (gh-pages landing page)", () => {
  it("links to every environment", () => {
    for (const { name } of ENVIRONMENTS) assert.match(hub, new RegExp(`href="${name}/"`));
  });
});
