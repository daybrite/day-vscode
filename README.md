# Day for VS Code

**Documentation: [vscode.daybrite.dev](https://vscode.daybrite.dev)** —
install and update, getting started, troubleshooting, and screenshots from the latest CI run.

Build and run [Day](https://daybrite.dev) apps — cross-platform native UI in Rust — across one or more
targets, straight from VS Code. It's a thin, conventional wrapper over the `day` CLI: each launch runs
as a VS Code **Task** in its own integrated terminal, so output is native (ANSI colors intact) and
filtered per target, and processes stop/restart through the standard task lifecycle.

## Features

- **Day sidebar** — pick a project, tick one or more targets, and Run / Build. Targets your host can't
  build (e.g. `windows-*` on macOS) are shown disabled.
- **Multiple simultaneous targets** — each selected target launches in its own terminal and can be
  **stopped / restarted independently** (inline buttons, or the status bar).
- **Build mode** (debug / release), **locale** (`--locale`), and an optional **dayscript**
  (`--script`) — all editable from the sidebar or command palette.
- **`day` task type** — auto-detected `day: build <target>` / `day: run <target>` tasks integrate with
  the Tasks system, `Ctrl+Shift+B`, and key bindings. Build errors surface via the `$rustc` matcher.
- **Doctor** — run `day doctor` to check your toolchains.

## Requirements

The `day` CLI:

```bash
cargo install day-cli
```

Set `day.cliPath` to your `day` binary. If it's left as `day` and isn't on `PATH`, the extension
falls back to `cargo run` against a local `day-cli` — so it works with no installed binary in two
layouts: when the **workspace is inside the Day repository**, and when a **`day/` checkout sits
beside this extension's own `day-vscode/` source** (the dev-host case, resolved via
`--manifest-path`, so a sibling project like `Day-Games/` loads too).

## Settings

| Setting | Default | Description |
|---|---|---|
| `day.cliPath` | `day` | Path to the `day` CLI (falls back to `cargo run` in the Day repo, or a `day/` checkout beside the extension source). |
| `day.defaultProfile` | `debug` | Default build mode. |
| `day.defaultLocale` | `""` | Default `--locale` (empty = app/system default). |
| `day.extraEnv` | `{}` | Extra `KEY=VALUE` env passed to every launch via `--env`. |
| `day.ohosNdkHome` | `""` | OpenHarmony NDK `native` dir for `harmony-arkui` (exported as `OHOS_NDK_HOME` in the task; empty = auto-detect `~/ohos/ndk-extract/native` or `~/ohos-sdk/native`; the SDK's `toolchains/` joins the task PATH for `hdc`). |

## Developing this extension

```bash
npm install
npm run compile   # or: npm run watch
```

Press **F5** (Run → "Run Day Extension") to open an Extension Development Host. Open any Day
project (a folder with a `Day.toml` — `day new app my-app` makes one); the **Day** sidebar
lists the app and its targets — tick `macos-appkit`, click **Run**, and the app launches in a
terminal. Tick a second target to run both at once; use the inline stop/restart buttons per
target. `npx @vscode/vsce package` produces an installable `.vsix`.

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

## License

[MPL-2.0](LICENSE), like Day itself.


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

## Install (from GitHub)

Not on the Marketplace yet — grab the `.vsix` from the
[releases page](https://github.com/daybrite/day-vscode/releases) and run
`code --install-extension day-vscode-<version>.vsix`, or build it yourself:
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
