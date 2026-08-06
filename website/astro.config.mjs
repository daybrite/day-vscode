// @ts-check
import { defineConfig } from 'astro/config';
import screenshots from './integrations/screenshots.mjs';

// Deployed to GitHub Pages under the repository name, so every internal link and asset has to go
// through `src/lib/site.ts`'s `url()` — a project page is served from /day-vscode/, not from the
// root the way daybrite.dev is.
export default defineConfig({
  site: 'https://daybrite.github.io',
  base: '/day-vscode',
  trailingSlash: 'ignore',
  // Same reason as the day website: lightningcss mishandles `background-clip: text`, which the
  // gradient headline depends on.
  vite: { build: { cssMinify: 'esbuild' } },
  integrations: [screenshots()],
  markdown: {
    shikiConfig: { theme: 'night-owl', wrap: false },
  },
});
