// Turn the e2e job's screenshot artifacts into the site's gallery data.
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
//   public/screenshots/<combo>/<file>.png   served images
//   src/data/screenshots.json               captions, dimensions, and provenance
//
// Editor surfaces arrive as a `-dark.png`/`-light.png` pair and become ONE entry carrying both, so
// the site can show whichever matches the reader's colour scheme. A capture with no theme in its
// name — the whole-desktop shots, or anything a driver from before this wrote — is one entry whose
// `light` and `dark` both point at the single file it has, which is what makes the gallery's
// swapping logic a comparison rather than a special case.
//
// Dimensions are read out of the PNG header rather than guessed, so every tile can reserve its
// exact aspect ratio and the gallery doesn't reflow as images load.

import { cpSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_IMAGES = join(ROOT, 'public', 'screenshots');
const OUT_DATA = join(ROOT, 'src', 'data', 'screenshots.json');

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

/** Human labels for the three hosts the e2e matrix covers. */
const COMBOS = {
  'macos-appkit': { os: 'macOS', toolkit: 'AppKit', order: 1 },
  'windows-xaml': { os: 'Windows', toolkit: 'XAML', order: 2 },
  'linux-gtk': { os: 'Linux', toolkit: 'GTK 4', order: 3 },
};

export function assembleScreenshots({ quiet = false, from } = {}) {
  const log = (m) => quiet || console.log(`[screenshots] ${m}`);
  const roots = from ? [resolve(from)] : SEARCH;

  const combos = new Map();
  for (const root of roots) {
    for (const [name, info] of findComboDirs(root)) {
      if (!combos.has(name)) combos.set(name, info);
    }
  }

  rmSync(OUT_IMAGES, { recursive: true, force: true });
  mkdirSync(OUT_IMAGES, { recursive: true });
  mkdirSync(dirname(OUT_DATA), { recursive: true });

  const platforms = [];
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
  }

  platforms.sort((a, b) => a.order - b.order);
  const data = { generated: new Date().toISOString(), platforms };
  writeFileSync(OUT_DATA, `${JSON.stringify(data, null, 2)}\n`);
  log(
    platforms.length
      ? `${platforms.length} platform(s), ${platforms.reduce((n, p) => n + p.shots.length, 0)} capture(s)`
      : 'no captures found — the gallery will say so (expected for a local build)',
  );
  return data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--from');
  assembleScreenshots({ from: i > 0 ? process.argv[i + 1] : undefined });
}
