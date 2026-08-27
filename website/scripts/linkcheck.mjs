// Internal link checker for the built site.
//
// Astro renders every docs page to `dist/docs/<slug>/index.html`, so a page is served from a
// DIRECTORY and a relative `./sibling` link resolves one level too deep — `/docs/getting-started/`
// + `./install` is `/docs/getting-started/install`, which does not exist. That shipped: the
// Getting started page's link to Install and update 404ed, and twelve more like it, none of them
// visible in the Markdown source or in a passing build.
//
// So this walks the built output rather than the sources: every internal href and every asset
// reference is resolved the way a browser resolves it, against the files actually emitted. It also
// checks `#fragments`, since a link into a heading that has been renamed is broken in the way that
// matters even though the page loads.
//
// External links are deliberately NOT fetched. They need the network, they rate-limit, and they go
// down for reasons that have nothing to do with this commit — a check that fails for those reasons
// gets ignored, and an ignored check protects nothing.
//
// Usage: node scripts/linkcheck.mjs [dist-dir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist");

/** Every file under `dir`, as paths relative to DIST with forward slashes. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(relative(DIST, full).split(/[\\/]/).join("/"));
    }
  }
  return out;
}

const files = new Set(walk(DIST));
const pages = [...files].filter((f) => f.endsWith(".html"));

/** The ids a page offers as fragment targets: `id="…"` and `name="…"`. */
function anchorsIn(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\s(?:id|name)="([^"]+)"/g)) {
    ids.add(m[1]);
  }
  return ids;
}

const anchors = new Map(
  pages.map((p) => [p, anchorsIn(readFileSync(join(DIST, p), "utf8"))]),
);

/**
 * Which emitted file a URL path would be served by, or undefined for a 404.
 *
 * Mirrors a static host: an exact file wins, otherwise a directory is served by its `index.html`,
 * with and without the trailing slash because `trailingSlash: 'ignore'` permits both spellings.
 */
function servedBy(path) {
  const clean = path.replace(/^\//, "").replace(/\/$/, "");
  if (clean === "") return "index.html";
  if (files.has(clean)) return clean;
  if (files.has(`${clean}/index.html`)) return `${clean}/index.html`;
  if (files.has(`${clean}.html`)) return `${clean}.html`;
  return undefined;
}

// `href` on links, `src` on images and scripts, plus srcset candidates.
const REFS = /(?:href|src)="([^"]*)"|srcset="([^"]*)"/g;

const problems = [];
for (const page of pages) {
  const html = readFileSync(join(DIST, page), "utf8");
  // The URL this page is served at, as a directory, so relative links resolve like a browser's.
  const base = `/${page.replace(/index\.html$/, "").replace(/\.html$/, "")}`;

  for (const m of html.matchAll(REFS)) {
    const raw = m[1] ?? "";
    const candidates = m[2]
      ? m[2].split(",").map((c) => c.trim().split(/\s+/)[0])
      : [raw];

    for (const value of candidates) {
      if (!value) continue;
      // Off-site, or not a document reference at all.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue;

      const [pathPart, fragment] = value.split("#");

      // A bare `#anchor` points into this same page.
      if (pathPart === "") {
        if (fragment && !anchors.get(page)?.has(fragment)) {
          problems.push({ page, value, why: "no such anchor on this page" });
        }
        continue;
      }

      const target = new URL(pathPart, `https://x${base}`).pathname;
      const served = servedBy(decodeURIComponent(target));
      if (!served) {
        problems.push({ page, value, why: `${target} is not in the build` });
      } else if (fragment && served.endsWith(".html")) {
        if (!anchors.get(served)?.has(decodeURIComponent(fragment))) {
          problems.push({ page, value, why: `${served} has no #${fragment}` });
        }
      }
    }
  }
}

const scanned = pages.length;
if (problems.length === 0) {
  console.log(`linkcheck: ${scanned} pages, no broken internal links`);
  process.exit(0);
}

console.error(`linkcheck: ${problems.length} broken link(s) in ${scanned} pages\n`);
for (const p of problems) {
  console.error(`  ${p.page}`);
  console.error(`    ${p.value}  →  ${p.why}`);
  // Picked up by the Actions log as an annotation on the job.
  if (process.env.GITHUB_ACTIONS) {
    console.error(`::error file=website/${p.page}::broken link ${p.value} (${p.why})`);
  }
}
process.exit(1);
