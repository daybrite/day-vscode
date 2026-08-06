// Assemble the gallery before Astro reads any module, so `src/data/screenshots.json` exists by the
// time a page imports it. `astro:config:setup` is the earliest hook and fires for dev and build
// alike, which keeps `npm run dev` and CI on the same path.
import { assembleScreenshots } from '../scripts/assemble-screenshots.mjs';

/** @returns {import('astro').AstroIntegration} */
export default function screenshots() {
  return {
    name: 'day-vscode-screenshots',
    hooks: {
      'astro:config:setup': ({ logger }) => {
        const { platforms } = assembleScreenshots({ quiet: true });
        logger.info(
          platforms.length
            ? `gallery: ${platforms.map((p) => `${p.combo} (${p.shots.length})`).join(', ')}`
            : 'gallery: no captures found — run test/e2e/drive.mjs or let CI supply them',
        );
      },
    },
  };
}
