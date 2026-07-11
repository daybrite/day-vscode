# Changelog

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
