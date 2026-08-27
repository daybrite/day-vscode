# Contributing to Day for VS Code

The extension is a thin wrapper over the [`day` CLI](https://github.com/daybrite/day): it discovers
projects, composes command lines, and runs them as VS Code tasks. Almost every behaviour question
("which targets exist?", "what does New Project ask?") is answered by the CLI, not by this
repository — so a change usually belongs on one side or the other, rarely both.

User-facing documentation lives at [vscode.daybrite.dev](https://vscode.daybrite.dev). This file is
for working on the extension itself.

## Getting set up

```bash
npm install
npm run compile   # type-check only; or: npm run watch
```

`dist/extension.js` — the esbuild bundle `package.json` `main` loads — is **not** in git: it is
derived from `src/`, and everything that needs it builds it (`vsce package` through
`vscode:prepublish`, both CI jobs, the `test:*` scripts, `scripts/dev.*`, and F5's pre-launch task).
`npm run compile` type-checks into `out/` and does not write it; `npm run prelaunch` does both.

Press **F5** (Run → "Run Day Extension") to open an Extension Development Host. Open any Day
project (a folder with a `Day.toml` — `day new app my-app` makes one); the **Day** sidebar
lists the app and its targets — tick `macos-appkit`, click **Run**, and the app launches in a
terminal. Tick a second target to run both at once; use the inline stop/restart buttons per
target. `npx @vscode/vsce package` produces an installable `.vsix`.

For the full loop — editing the framework and the app that exercises it in one window — use the
dev launcher instead:

```bash
scripts/dev.sh ../Day-Showcase                                            # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 ..\Day-Showcase  # Windows
```

The arguments are the Day apps to open, and they work for **any** Day project. Omit them and the app
is the nearest ancestor of the current directory holding a `Day.toml` — the same rule `day --project`
follows — so running the script from inside an app needs no argument at all:

```bash
cd ~/apps/MyApp && ~/src/day-vscode/scripts/dev.sh
```

With no argument and no `Day.toml` to find — a fresh clone, before there is anything to open — the
script installs this repository's dependencies and opens a window on the extension's welcome page,
which is where **Create a Day Project** lives. That is the shortest path from `git clone` to a
running app.

Name several to open them in one window, each patched at the same `day/` checkout:

```bash
cd ~/src/daybrite && day-vscode/scripts/dev.sh Day-Sketch Day-Showcase
```

Every app appears in the Day sidebar with its own targets and its own build mode, locale and
dayscript. The focused one — what the Configuration rows and the plain Run button act on — follows
the file you're editing, or you can click its row.

Either way the script bundles the extension from this working tree, builds `day-cli` from the
sibling `day/` checkout, runs `day patch --local` for each app so its cargo resolution points at
that same checkout, and opens an Extension Development Host on a multi-root workspace holding
**the apps first, then `day/`**. An edit to any `day/` crate — core, toolkit, piece, part — lands in
the next Build or Run the extension starts, and because the workspace sets `day.cliSource` to the
checkout, an edit to **day-cli itself** does too: the editor runs the CLI through `cargo run`
rather than a binary built once at launch. Both scripts need a `day/` checkout beside this
repository; neither needs an installed `day` on `PATH`, and neither uses one if it is there.

Releases: pushing a `v*` tag builds, packages, and publishes to the Visual Studio Marketplace
and Open VSX (see `.github/workflows/ci.yml`). The extension's release cycle is independent of
[day](https://github.com/daybrite/day)'s — it drives whatever `day` CLI is installed.

### The documentation site

`website/` is an Astro site deployed to <https://vscode.daybrite.dev> by the `website`
job. Its screenshot gallery is assembled from the `screenshots-<combo>` artifacts the e2e job
uploads, newest first, so a docs-only change still ships the last captures.

```bash
cd website
npm install
npm run dev      # picks up ../build/screenshots/ from a local test:e2e run
```

### Tests

Both suites scaffold their own project with `day new app`, so they need a `day` CLI: either on
`PATH` or named by `DAY_BIN`.

```bash
npm run test:integration   # ~1 min: a real extension host, no UI automation
npm run test:e2e           # drives the packaged .vsix and writes build/screenshots/
npm run test:e2e -- --no-run   # …skipping the app build, which is most of the time
```

`test:integration` checks activation, the command registrations, and the task list, which is the
CLI seam: tasks exist only if `day metadata --json` ran and parsed. `test:e2e` installs the
`.vsix` into a pinned VS Code, opens the scaffold, ticks this host's own combo, runs it, and
photographs each step. CI runs both per host — macOS builds `macos-appkit`, Windows
`windows-xaml`, Linux `linux-gtk` — and uploads the screenshots.

## AI agents

In a Day workspace the extension registers the **Day MCP server** (`day mcp-server`) with VS
Code's agent mode automatically (`day.mcp.enabled`, default on). Agents get tools to inspect the
project (`day_metadata`, `day_doctor`, `day_lint`), build and run it (`day_build`, `day_launch`,
`day_relaunch`, `day_stop`, `day_running`), and — through the dayscript engine inside every
launch — **drive the running app and see screenshots** (`day_drive`, `day_screenshot`) on every
platform the app targets. Try, in agent mode:

> Add a new "configuration" page to the app and re-launch it on all targets, then show me
> screenshots.

Scaffolded projects include an `AGENTS.md` teaching agents the project's conventions
(pages, localization keys, stable ids, and the relaunch→drive→screenshot verification loop).

## Installing a build

The published extension is on the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode). To try an
unreleased build, take the `.vsix` from the
[releases page](https://github.com/daybrite/day-vscode/releases) and run
`code --install-extension day-vscode-<version>.vsix`, or build one yourself with
`npm install && npx vsce package`.


## Publishing

CI validates Marketplace publishability on every push (strict `vsce package` + the documented
requirements checklist). Tagging `v*` attaches the `.vsix` to a GitHub Release; actual
Marketplace / Open VSX publication is fully wired but **off** until the repository variables
flip. Marketplace auth is **tokenless** — Entra ID workload-identity federation via GitHub
OIDC and `vsce publish --azure-credential` (Azure DevOps PATs retire Dec 1 2026); Open VSX
keeps its own `OVSX_PAT` secret. The header of `.github/workflows/ci.yml` documents the
one-time Azure/Marketplace setup, the `MARKETPLACE_PUBLISH` / `AZURE_*` variables, and a
no-upload dry-run you can trigger from the Actions tab.
