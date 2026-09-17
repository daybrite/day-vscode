// Assemble the gallery before Astro reads any module, so `src/data/screenshots.json` exists by the
// time a page imports it. `astro:config:setup` is the earliest hook and fires for dev and build
// alike, which keeps `npm run dev` and CI on the same path.
//
// The same pass writes `public/screenshots/gallery.json` and `public/screenshots/
// day-vscode-screenshots.zip`, which Astro then copies into `dist/` like any other public file.
// Running here rather than at `astro:build:done` is what puts them there: `public/` is copied
// early, so anything written afterwards misses the build.
import { assembleScreenshots } from '../scripts/assemble-screenshots.mjs';

/** @returns {import('astro').AstroIntegration} */
export default function screenshots() {
  return {
    name: 'day-vscode-screenshots',
    hooks: {
      // `config.site` is the absolute host the manifest's `url` fields are built on, so the two
      // cannot drift: move the site in astro.config.mjs and gallery.json follows.
      'astro:config:setup': ({ config, logger }) => {
        const { platforms, manifest } = assembleScreenshots({ quiet: true, site: config.site });
        logger.info(
          platforms.length
            ? `gallery: ${platforms.map((p) => `${p.combo} (${p.shots.length})`).join(', ')}` +
                ` → ${manifest.archive.path}`
            : 'gallery: no captures found — run test/e2e/drive.mjs or let CI supply them',
        );
      },
    },
  };
}
