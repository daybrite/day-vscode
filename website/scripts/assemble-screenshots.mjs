// Turn the e2e job's screenshot artifacts into the site's gallery data.
//
//     node scripts/assemble-screenshots.mjs [--from DIR]
//
// The captures come from `test/e2e/drive.mjs`, which drives the packaged extension on each desktop
// host and writes `<combo>/<combo>-NN-name.png` plus a `manifest.json` of captions. CI downloads
// those artifacts; a developer who has run the driver locally already has them under
// `../build/screenshots/`. Both layouts are accepted, so `npm run dev` shows real screenshots when
// they exist and says so plainly when they don't.
//
// Output:
//   public/screenshots/<combo>/<file>.png   served images
//   src/data/screenshots.json               captions, dimensions, and provenance
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
        captions[shot.file.replace(/^.*[\\/]/, '')] = shot.caption;
      }
    } catch {
      captions = {};
    }

    cpSync(dir, join(OUT_IMAGES, combo), { recursive: true, filter: (s) => !s.endsWith('.json') });

    const shots = readdirSync(join(OUT_IMAGES, combo))
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((file) => {
        const size = pngSize(join(OUT_IMAGES, combo, file)) ?? { width: 1440, height: 900 };
        // `macos-appkit-01-cockpit.png` → step 01, slug "cockpit".
        const m = /-(\d+)-([a-z0-9-]+)\.png$/.exec(file);
        return {
          file: `screenshots/${combo}/${file}`,
          step: m ? Number(m[1]) : 99,
          slug: m ? m[2] : file.replace(/\.png$/, ''),
          caption: captions[file] ?? (m ? m[2].replace(/-/g, ' ') : file),
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
