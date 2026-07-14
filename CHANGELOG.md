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
