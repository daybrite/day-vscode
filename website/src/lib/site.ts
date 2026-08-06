// Base-path-aware URLs and the one place that knows where the Day docs live.
//
// This site is a GitHub project page, so it is served from /day-vscode/, not from the root: every
// internal link and asset goes through `url()`. Framework documentation is NOT duplicated here —
// `dayDocs()` builds links into daybrite.dev, and the docs pages lean on it heavily.

export const BASE: string = import.meta.env.BASE_URL;

/** Join a path onto the site base: `url('docs/install')` → `/day-vscode/docs/install`. */
export function url(path = ''): string {
  return BASE.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

/**
 * A page on daybrite.dev/docs. Keep the slugs in step with day/website/src/content/docs/.
 *
 * The trailing slash is the canonical form there: without it every link costs the reader a 301.
 */
export function dayDocs(slug = ''): string {
  const s = slug.replace(/^\//, '').replace(/\/$/, '');
  return `https://daybrite.dev/docs/${s}${s ? '/' : ''}`;
}

export const site = {
  name: 'Day for VS Code',
  tagline: 'Build and run Day apps without leaving the editor',
  description:
    'The VS Code extension for Day: pick your targets, build and run them from the sidebar, and read the output in the editor. A thin wrapper over the day CLI.',
  repo: 'https://github.com/daybrite/day-vscode',
  // The current install channel. There is no Marketplace listing yet — publication is wired in
  // CI but switched off, so linking it would 404.
  vsix: 'https://github.com/daybrite/day-vscode/releases/latest/download/day-vscode.vsix',
  day: 'https://daybrite.dev',
};
