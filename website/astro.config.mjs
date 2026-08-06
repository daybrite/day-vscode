// @ts-check
import { defineConfig } from 'astro/config';
import screenshots from './integrations/screenshots.mjs';

// Deployed to GitHub Pages on the custom domain https://vscode.daybrite.dev (public/CNAME pins
// it), which serves from the root — so there is no base path. Internal links still go through
// `src/lib/site.ts`'s `url()`: it costs nothing at the root and means moving the site again is one
// line here rather than an edit in every template.
export default defineConfig({
  site: 'https://vscode.daybrite.dev',
  trailingSlash: 'ignore',
  // Same reason as the day website: lightningcss mishandles `background-clip: text`, which the
  // gradient headline depends on.
  vite: { build: { cssMinify: 'esbuild' } },
  integrations: [screenshots()],
  markdown: {
    shikiConfig: { theme: 'night-owl', wrap: false },
  },
});
