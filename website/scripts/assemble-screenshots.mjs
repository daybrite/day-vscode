// Turn the e2e job's screenshot artifacts into the site's gallery data, its published manifest,
// and the zip other processes download.
//
//     node scripts/assemble-screenshots.mjs [--from DIR]
//
// The captures come from `test/e2e/drive.mjs`, which drives the packaged extension on each desktop
// host and writes `<combo>/<combo>-NN-name-<theme>.png` plus a `manifest.json` of captions. CI
// downloads those artifacts; a developer who has run the driver locally already has them under
// `../build/screenshots/`. Both layouts are accepted, so `npm run dev` shows real screenshots when
// they exist and says so plainly when they don't.
//
// Output:
//   public/screenshots/<combo>/<file>.png          served images
//   public/screenshots/gallery.json                the published manifest (see below)
//   public/screenshots/day-vscode-screenshots.zip  that manifest plus every image
//   src/data/screenshots.json                      what the gallery page renders from
//
// The first three are served as they are, so the manifest and the archive have fixed addresses:
//
//   https://vscode.daybrite.dev/screenshots/gallery.json
//   https://vscode.daybrite.dev/screenshots/day-vscode-screenshots.zip
//
// gallery.json follows the schema `day screenshot index` writes for app galleries (day/crates/
// day-cli/src/screenshot.rs, published by every Day-* app at `<host>/gallery/gallery.json`), so a
// consumer that already reads one reads this. One row per FILE, carrying its platform, theme,
// pixel dimensions, byte size and SHA-256, with `path` relative to the site root and `url`
// absolute. It differs from an app gallery in two places: the images live under `screenshots/`
// rather than `gallery/`, because that is where this site has always served them, and `locales` is
// empty, because the driver captures one language.
//
// `src/data/screenshots.json` stays separate and grouped by platform, which is the shape the
// gallery page wants; gallery.json is the one for machines.
//
// Editor surfaces arrive as a `-dark.png`/`-light.png` pair and become ONE entry in the page data
// carrying both, so the site can show whichever matches the reader's colour scheme. A capture with
// no theme in its name — the whole-desktop shots, or anything a driver from before this wrote — is
// one entry whose `light` and `dark` both point at the single file it has, which is what makes the
// gallery's swapping logic a comparison rather than a special case. gallery.json does not group:
// each file is its own row there, themed or not, the way an app gallery lists its variants.
//
// Dimensions are read out of the PNG header rather than guessed, so every tile can reserve its
// exact aspect ratio and the gallery doesn't reflow as images load.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync } from 'fflate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_IMAGES = join(ROOT, 'public', 'screenshots');
const OUT_DATA = join(ROOT, 'src', 'data', 'screenshots.json');

/** The published manifest, beside the images it indexes so its relative paths resolve. */
const MANIFEST_FILE = 'gallery.json';
/** The archive, named for the project rather than its directory: it is also a release asset. */
const ARCHIVE_FILE = 'day-vscode-screenshots.zip';
/** Where the site is served, when nothing passes it. Matches `astro.config.mjs` and `lib/site.ts`. */
const SITE = 'https://vscode.daybrite.dev';

/** Where captures may be found, in order of preference. */
const SEARCH = [
  // CI: `actions/download-artifact` with `pattern: screenshots-*` lands each artifact in its own
  // directory, and each artifact already contains a <combo>/ directory of its own.
  join(ROOT, 'screenshot-artifacts'),
  // Local: the driver's own output directory, two levels up from the site.
  join(ROOT, '..', 'build', 'screenshots'),
];

/** Read width/height from a PNG's IHDR chunk (bytes 16..24). No image library needed. */
function pngSize(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) return null;
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** Every directory under `dir` that looks like a capture set (has PNGs named `<combo>-NN-…`). */
function findComboDirs(dir, depth = 0, found = new Map()) {
  if (depth > 3 || !existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const pngs = readdirSync(path).filter((f) => f.endsWith('.png'));
    if (pngs.length) {
      // The directory name is the combo (`macos-appkit`), and the newest file in it dates the set.
      const newest = Math.max(...pngs.map((f) => statSync(join(path, f)).mtimeMs));
      const prev = found.get(entry.name);
      if (!prev || newest > prev.capturedMs) {
        found.set(entry.name, { dir: path, capturedMs: newest });
      }
    } else {
      findComboDirs(path, depth + 1, found);
    }
  }
  return found;
}

/**
 * `macos-appkit-01-cockpit-dark.png` → step 1, slug "cockpit", theme "dark".
 *
 * The slug is lazy so that the optional theme suffix wins the tail of the name: greedy, the slug
 * of `03-select-targets-light.png` would swallow `-light` and the pair would never group.
 */
const SHOT_NAME = /-(\d+)-([a-z0-9-]+?)(?:-(dark|light))?\.png$/;

/**
 * A capture's identity WITHOUT its theme — the key captions are stored and looked up under.
 * The manifest names one variant per shot; which one is not this script's business.
 */
const captionKey = (path) =>
  path.replace(/^.*[\\/]/, '').replace(/-(?:dark|light)\.png$/, '.png');

/**
 * `select-targets` → `Select Targets`, the label `day screenshot index` derives for a shot with
 * no `title:` of its own (day/crates/day-cli/src/screenshot.rs, `derived_label`). Title case on
 * every word, which is that function's rule; matching it is what lets the two indexes be read by
 * the same code.
 */
const label = (slug) =>
  slug.replace(/[-_]/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Human labels for the three hosts the e2e matrix covers. */
const COMBOS = {
  'macos-appkit': { os: 'macOS', toolkit: 'AppKit', order: 1 },
  'windows-xaml': { os: 'Windows', toolkit: 'XAML', order: 2 },
  'linux-gtk': { os: 'Linux', toolkit: 'GTK 4', order: 3 },
};

// ── Zip ──────────────────────────────────────────────────────────────────────────────────────
// `fflate`'s `zipSync` is the archiver: one synchronous call, no transitive dependencies, and a
// per-entry `mtime` so each capture keeps its own date in the archive.
//
// Level 9 throughout. The captures are PNGs, deflate streams already, and re-deflating this set
// takes it from 5.14 MB to 4.97 MB in 140 ms — measured, along with level 6, which produced a
// byte-identical archive in the same time. The manifest is where compression earns something:
// JSON, down to a sixth of itself.

export function assembleScreenshots({ quiet = false, from, site = SITE } = {}) {
  const log = (m) => quiet || console.log(`[screenshots] ${m}`);
  const roots = from ? [resolve(from)] : SEARCH;
  const host = site.replace(/\/$/, '');

  const combos = new Map();
  for (const root of roots) {
    for (const [name, info] of findComboDirs(root)) {
      if (!combos.has(name)) combos.set(name, info);
    }
  }

  rmSync(OUT_IMAGES, { recursive: true, force: true });
  mkdirSync(OUT_IMAGES, { recursive: true });
  mkdirSync(dirname(OUT_DATA), { recursive: true });

  const generated = new Date();
  const platforms = [];
  /** One row per capture file, in platform then step order: gallery.json's `screenshots`. */
  const captures = [];
  /** Each row's position as it was appended, which is its combo's step order. */
  const order = new Map();
  /** The archive's members, alongside the manifest that is added once it is written. */
  const archived = [];
  for (const [combo, { dir, capturedMs }] of combos) {
    const meta = COMBOS[combo];
    if (!meta) {
      log(`skipping unknown combo ${combo}`);
      continue;
    }
    // Captions come from the driver's manifest when it rode along; a capture set without one
    // still renders, titled from its file name.
    let captions = {};
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      for (const shot of manifest.shots ?? []) {
        captions[captionKey(shot.file)] = shot.caption;
      }
    } catch {
      captions = {};
    }

    cpSync(dir, join(OUT_IMAGES, combo), { recursive: true, filter: (s) => !s.endsWith('.json') });

    // One entry per surface, gathering that surface's theme variants as they are met.
    const byShot = new Map();
    /** Every file of this combo, for the manifest, which lists them one by one. */
    const files = [];
    for (const file of readdirSync(join(OUT_IMAGES, combo)).filter((f) => f.endsWith('.png')).sort()) {
      const m = SHOT_NAME.exec(file);
      const step = m ? Number(m[1]) : 99;
      const slug = m ? m[2] : file.replace(/\.png$/, '');
      const key = `${step}-${slug}`;
      if (!byShot.has(key)) {
        byShot.set(key, {
          step,
          slug,
          caption: captions[captionKey(file)] ?? slug.replace(/-/g, ' '),
          themed: {},
          plain: null,
        });
      }
      const entry = byShot.get(key);
      const rel = `screenshots/${combo}/${file}`;
      if (m?.[3]) entry.themed[m[3]] = rel;
      else entry.plain = rel;
      files.push({ file, step, slug, theme: m?.[3] ?? null, caption: entry.caption });
    }

    const shots = [...byShot.values()]
      .map(({ step, slug, caption, themed, plain }) => {
        // Dark is the site's own default, so it is the one an unthemed reader gets and the one
        // whose header supplies the dimensions.
        const file = themed.dark ?? plain ?? themed.light;
        const size = pngSize(join(ROOT, 'public', file)) ?? { width: 1440, height: 900 };
        return {
          file,
          dark: themed.dark ?? file,
          light: themed.light ?? file,
          step,
          slug,
          caption,
          ...size,
        };
      })
      .sort((a, b) => a.step - b.step);

    if (!shots.length) continue;
    platforms.push({
      combo,
      ...meta,
      captured: new Date(capturedMs).toISOString(),
      shots,
    });

    // The manifest rows and the archive's members, both read straight off the copied files, so
    // what the sha-256 describes is the byte sequence the site serves.
    for (const f of files.sort((a, b) => a.step - b.step || a.file.localeCompare(b.file))) {
      const abs = join(OUT_IMAGES, combo, f.file);
      const bytes = readFileSync(abs);
      const path = `screenshots/${combo}/${f.file}`;
      const row = {
        file: f.file,
        path,
        url: `${host}/${path}`,
        shot: f.slug,
        title: label(f.slug),
        caption: f.caption,
        platform: combo,
        os: meta.os,
        toolkit: meta.toolkit,
        // An app gallery's variant names a theme/locale pair; here it is the theme alone, and
        // `default` for the whole-desktop captures, which follow the OS rather than VS Code.
        variant: f.theme ?? 'default',
        theme: f.theme,
        locale: null,
        ...(pngSize(abs) ?? { width: null, height: null }),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      order.set(row, captures.length);
      captures.push(row);
      // Dated from the source rather than the copy: `cpSync` stamps what it writes with the time
      // of the copy, and the capture's own time is the useful one in an archive.
      archived.push({
        name: `${combo}/${f.file}`,
        data: bytes,
        date: statSync(join(dir, f.file)).mtime,
      });
    }
  }

  platforms.sort((a, b) => a.order - b.order);
  // Grouped by platform in the matrix's own order — the capture directories are met in whatever
  // order the filesystem lists them — and within a platform in the driver's step order, which is
  // the order the pictures tell their story in. Sorting on the recorded position rather than the
  // file name keeps that true for a capture whose name carries no step number.
  captures.sort(
    (a, b) =>
      (COMBOS[a.platform]?.order ?? 99) - (COMBOS[b.platform]?.order ?? 99) ||
      order.get(a) - order.get(b),
  );
  const data = { generated: generated.toISOString(), platforms };
  writeFileSync(OUT_DATA, `${JSON.stringify(data, null, 2)}\n`);

  // The shot vocabulary, one entry per captured surface across all platforms, in the driver's own
  // step order. `day screenshot index` writes localized maps here; the driver captures English
  // only, so every map has the one key.
  const shotIds = [...new Set(captures.map((c) => c.shot))];
  const manifest = {
    generator: 'day-vscode assemble-screenshots',
    generated: generated.toISOString(),
    site: host,
    themes: [...new Set(captures.map((c) => c.theme).filter(Boolean))],
    locales: [],
    platforms: platforms.map((p) => p.combo),
    // Where the same set can be had in one request. Its own bytes are not described here, because
    // this file is inside it; each image's sha-256 above is what a consumer verifies.
    archive: {
      file: ARCHIVE_FILE,
      path: `screenshots/${ARCHIVE_FILE}`,
      url: `${host}/screenshots/${ARCHIVE_FILE}`,
    },
    shots: shotIds.map((id) => {
      const c = captures.find((x) => x.shot === id);
      return {
        id,
        title: { en: c.title },
        caption: c.caption ? { en: c.caption } : null,
        source: null,
      };
    }),
    screenshots: captures,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(OUT_IMAGES, MANIFEST_FILE), manifestJson);

  // Written even with nothing to put in it: the two addresses are published, and a consumer that
  // polls them is better served by an empty archive and an empty index than by a 404.
  //
  // `zipSync` takes `{ 'path/in/archive': [bytes, options] }`; a key with slashes in it is the
  // nested path, so the `<combo>/<file>.png` names need no directory entries of their own.
  const members = Object.fromEntries(
    [{ name: MANIFEST_FILE, data: Buffer.from(manifestJson, 'utf8'), date: generated }, ...archived]
      .map(({ name, data, date }) => [name, [data, { mtime: date }]]),
  );
  const archive = Buffer.from(zipSync(members, { level: 9 }));
  writeFileSync(join(OUT_IMAGES, ARCHIVE_FILE), archive);

  log(
    platforms.length
      ? `${platforms.length} platform(s), ${captures.length} capture(s) → ${MANIFEST_FILE} + ` +
          `${ARCHIVE_FILE} (${(archive.length / 1024 / 1024).toFixed(1)} MB)`
      : 'no captures found — the gallery will say so (expected for a local build)',
  );
  return { ...data, manifest, archiveBytes: archive.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--from');
  assembleScreenshots({ from: i > 0 ? process.argv[i + 1] : undefined });
}
