## Updating the CLI

The Day view compares the CLI you have against the newest release on crates.io. Updating re-runs
whichever route installed it, replacing it in place — there is no separate update command.

`day.cliVersion` decides what an install fetches: empty for the newest release, `main` for the
development branch, or any git tag.

- [Getting the CLI](https://vscode.daybrite.dev/docs/install) — including `day.cliVersion`
- [Commands and settings](https://vscode.daybrite.dev/docs/reference) — every setting this extension adds
