## Unreleased

- **Verbose** — run `day build` and `day launch` with `--verbose`, so the task terminal shows
  every sub-command they execute (cargo, gradle, xcodebuild, hvigor, adb, codesign, …) and its
  raw output instead of Day's status lines alone. Off by default; applies to tasks, the
  tree/status-bar runs built from them, and debug launches. Toggle it with the checkbox in the
  Day sidebar's Configuration section, `Day: Toggle Verbose Build Output` in the palette, or
  the `day.verbose` setting.
- **Run and Debug**: `Start Debugging` on a desktop target now stops on breakpoints in Rust. Day
  builds the app and hands the binary to a debugger you already have — LLDB DAP, CodeLLDB, or
  C/C++, probed in that order and pinnable with `day.debug.adapter` — passing the same launch
  environment `day launch` uses, so a stopped app still finds its images, vectors, fonts, and
  identity. Device and browser targets, `Run Without Debugging`, and hosts with no debugger
  installed keep launching through the Debug Console as before. Needs a `day` CLI that reports a
  `launch` plan in `day build --format json`. Put breakpoints in the library crate: `macos-appkit`
  builds through an Xcode host project that supplies its own `main`, so `src/main.rs` is not part of
  that binary and a breakpoint there never binds.
- `scripts/dev.ps1` — the Windows counterpart of `scripts/dev.sh`: opens both the app and the
  sibling `day/` checkout in one Extension Development Host, with the app's cargo resolution
  patched at that checkout.
- Both dev launchers take the Day project as their argument and work against any app, instead of
  defaulting to `Day-Showcase`. With no argument they use the nearest ancestor of the current
  directory holding a `Day.toml`, so running one from inside an app needs no argument.

- CLI resolution: when the extension runs from a `day-vscode/` source checkout that sits beside a
  `day/` repo, it now builds the CLI from that peer repo via `cargo run --manifest-path`, so a
  project opened from anywhere (e.g. a sibling `Day-Games/`) loads without an installed `day` on
  PATH — not only projects opened from inside the Day repo.
- A Day.toml found but unloadable no longer masquerades as "No Day project found": the sidebar
  shows a distinct message, a notification names the cause (e.g. the `day` CLI couldn't run), and
  the full attempted command and error go to a new **Day** output channel (`Day: Show Log`).

## 0.4.2

- Fixed: desktop apps launched with `--keep-alive` died when the VS Code task's terminal was
  disposed (pty SIGHUP to the process group) — detached launches now run in their own process
  group on every OS, so they survive like the mobile targets always did.
- Settings panel: Day's preferences are grouped into titled sections (Day / Scripts /
  AI · Agents) in the native Settings UI; a gear in the Day view title opens them filtered.
- `Day: Toggle Keep App Running After Script` command; the cockpit's script item shows a pin
  when keep-alive is on, and its hover toggles it in place.

## 0.4.0

- Agentic development: registers `day mcp-server` with VS Code (1.101+) for every Day
  workspace (`day.mcp.enabled`, default on) — agent mode gets ten `day_*` tools to build,
  launch, relaunch, stop, and DRIVE running apps, with screenshots returned as images.
- `Day: New Project…` — name → target multi-pick → folder, scaffolds with `day new` and opens
  the app (which now ships `AGENTS.md` + `.vscode/extensions.json`).

## 0.3.0

- Status-bar cockpit: run/stop toggle, a target item (short names + live spinner) opening a
  multi-select target picker, build mode, and a locale/dayscript context item — each with a
  rich hover that can run/stop/build any target directly.
- Vendored `$day-rustc` / `$day-rustc-watch` problem matchers (the stock `$rustc` name only
  exists when rust-analyzer is installed); attached to all day tasks, launches included.
- `resolveTask` reuses the incoming task definition verbatim, so hand-written `day` tasks in
  tasks.json (and `preLaunchTask` references) resolve correctly and fast.
- Day.toml validation: associates https://daybrite.dev/schema/day.toml.json (emitted by
  `day metadata --schema`) through Even Better TOML's schema associations.
- Hygiene: esbuild bundling, `engines.vscode ^1.101`, Restricted Mode / virtual workspace
  capability declarations, activation trimmed to `workspaceContains:**/Day.toml`.

# Changelog

## 0.2.0

- Day projects are now marked by a `Day.toml` manifest (replacing `day.yaml`) — requires a
  day-cli with the `day metadata` command.
- Project metadata (identity, targets) is read via `day metadata --json` instead of parsing
  the manifest in the extension, and the target catalog now comes from the installed CLI (the
  built-in catalog remains only as an offline fallback).

## 0.1.0

Initial standalone release (extracted from the [day](https://github.com/daybrite/day)
repository's `editors/vscode/`, history preserved).

- Day sidebar: project + target tree with per-target run / stop / restart.
- Multi-target launch (tick several targets, run them side by side).
- Mode (debug/release), locale, and dayscript selection.
- `day` task provider and example tasks.
- Project detection via `day.yaml`; `day doctor` integration.
- Falls back to `cargo run -q -p day-cli --` inside a day workspace when no `day` binary is
  on `PATH`.
