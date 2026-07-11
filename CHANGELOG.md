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
