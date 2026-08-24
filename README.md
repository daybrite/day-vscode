# Day for VS Code

**Documentation: [vscode.daybrite.dev](https://vscode.daybrite.dev)** —
install and update, getting started, troubleshooting, and screenshots from the latest CI run.

Build and run [Day](https://daybrite.dev) apps — cross-platform native UI in Rust — across one or more
targets, straight from VS Code. It's a thin, conventional wrapper over the `day` CLI: each launch runs
as a VS Code **Task** in its own integrated terminal, so output is native (ANSI colors intact) and
filtered per target, and processes stop/restart through the standard task lifecycle.

## Features

- **Day sidebar** — every Day app in the window is listed, each expanding to its own targets. Tick
  targets and Run / Build. Targets your host can't build (e.g. `windows-*` on macOS) are shown
  disabled.
- **Many apps in one window** — open a dozen Day projects side by side and drive them together.
  Each keeps its own ticked targets, build mode, locale and dayscript; each gets its own terminal
  per target, so two apps building `macos-appkit` never collide. `Run` launches the focused
  project, `Day: Run All Projects` launches every ticked target everywhere, and a project row has
  its own inline run/stop. The focused project follows the file you're editing
  (`day.followActiveEditor`).
- **Pick the device** — mobile targets expand to a Device row: a booted simulator, a plugged-in
  phone, an emulator, or **All connected** (the default). Fed by `day devices list`, so the picker
  shows what is actually attached, and can start a simulator that is not running.
- **Multiple simultaneous targets** — each selected target launches in its own terminal and can be
  **stopped / restarted independently** (inline buttons, or the status bar).
- **Build mode** (debug / release), **locale** (`--locale`), an optional **dayscript**
  (`--script`), a **Verbose** checkbox (`--verbose`, to see every sub-command a build runs), and a
  **Log level** (`DAY_LOG` for the launched app, `trace` by default) — all editable from the
  sidebar or command palette.
- **`day` task type** — auto-detected `day: build <target>` / `day: run <target>` tasks integrate with
  the Tasks system, `Ctrl+Shift+B`, and key bindings. Build errors surface via the `$rustc` matcher.
- **Run and Debug (F5)** — a `day` launch type in the Run panel. On a desktop target, **Start
  Debugging** builds the app and hands the binary to a Rust debugger you already have installed, so
  breakpoints in `.rs` files are real. See [Debugging](#debugging).
- **Doctor** — run `day doctor` to check your toolchains.

## Debugging

Press **F5**, or pick a `Day: Run <target>` configuration in the Run and Debug panel. With no
`launch.json` at all, F5 runs whatever the Day sidebar has ticked, in the current mode and locale.

For a **desktop target**, Day builds the app and then starts one of these — whichever is installed,
in this order — pointed at the built binary:

| Debugger | Extension |
|---|---|
| LLDB DAP | `llvm-vs-code-extensions.lldb-dap` |
| CodeLLDB | `vadimcn.vscode-lldb` |
| C/C++ | `ms-vscode.cpptools` (`cppvsdbg` on Windows, `cppdbg` elsewhere) |

Day ships no debug adapter of its own; it supplies the program, working directory, and the full
launch environment `day launch` would have used, so an app stopped at a breakpoint still finds its
images, vectors, fonts, and app identity. Pin one with `day.debug.adapter`, or set it to `none` to
always run without a debugger.

Everything else runs without a debugger, in the Debug Console: device and browser targets
(`ios-uikit`, `android-mdc`, `harmony-arkui`, `web-dom`), **Run Without Debugging** (`Ctrl+F5`), and
any host with none of the extensions above installed. The app still launches — you just don't stop
on breakpoints, and the reason is reported.

Two things a debug session does not do, because it starts the binary directly rather than through
`day launch`: it does not drive a selected **dayscript** (use Run Without Debugging for that), and
it cannot apply the `xvfb-run` wrapper a headless Linux host needs.

### Where breakpoints bind

Put breakpoints in your **library** crate (`src/lib.rs` and below). On `macos-appkit` the app is
built through an Xcode host project that supplies its own `main`, and your Rust code is linked in as
a static library — so nothing in the binary crate's `src/main.rs` exists to break on, and a
breakpoint there stays hollow. The cargo-built targets (`*-gtk`, `*-qt`, `windows-xaml`) build
`src/main.rs` directly and do bind there.

A breakpoint VS Code shows as hollow rather than filled never bound; that is the signal, and it is
worth checking before assuming the debugger did not attach.

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
| `day.cliSource` | `""` | Path to a `day` **source checkout**. When set, every CLI call runs as `cargo run --manifest-path <path>/Cargo.toml -q -p day-cli --`, so edits to the CLI reach the next build with no rebuild step. Takes precedence over `day.cliPath`; needs `cargo` on the editor's PATH (falls back to the checkout's built binary without it). |
| `day.defaultProfile` | `debug` | Default build mode. |
| `day.defaultLocale` | `""` | Default `--locale` (empty = app/system default). |
| `day.verbose` | `false` | Run builds and launches with `--verbose`, showing every sub-command they execute (cargo, gradle, xcodebuild, hvigor, adb, …) and its raw output. **Per project.** |
| `day.logLevel` | `trace` | `DAY_LOG` level passed to every launch via `--env` (`trace` shows everything, per-statement SQL included; a `DAY_LOG` in `day.extraEnv` wins). **Per project.** |
| `day.extraEnv` | `{}` | Extra `KEY=VALUE` env passed to every launch via `--env`. **Per project.** |
| `day.followActiveEditor` | `true` | Focus the Day project the active editor's file belongs to. |
| `day.ohosNdkHome` | `""` | OpenHarmony NDK `native` dir for `harmony-arkui` (exported as `OHOS_NDK_HOME` in the task; empty = auto-detect `~/ohos/ndk-extract/native` or `~/ohos-sdk/native`; the SDK's `toolchains/` joins the task PATH for `hdc`). |

Settings marked **Per project** are folder-scoped: put them in one app's `.vscode/settings.json`
and they apply to that app alone, which is how several apps in one window run with different log
levels or environments. The Day sidebar's Verbose and Log level rows write to the focused project's
folder.

## Developing this extension

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
