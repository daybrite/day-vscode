---
title: Commands and settings
description: Every command, setting, task property, and launch attribute the extension contributes.
order: 4
section: Extension
---

# Commands and settings

Everything the extension adds to VS Code. What the underlying flags mean belongs to the CLI, and
[daybrite.dev/docs/cli](https://daybrite.dev/docs/cli/) documents it.

## Commands

All of these are under the **Day** category in the command palette.

| Command | What it does |
|---|---|
| Run Selected Targets | Launches every ticked target, one task each |
| Build Selected Targets | Builds them without launching |
| Stop All | Stops every run this extension started |
| Select Targets | Ticks targets from a quick pick |
| Select Build Mode | debug or release |
| Select Locale | Sets `--locale` for later runs |
| Select Dayscript | Picks a `.yaml` under `dayscript/` |
| Select Project | Chooses between projects in a multi-root workspace |
| Doctor (check toolchains) | Runs `day doctor` |
| New Project… | Runs `day new app` and opens the result |
| Refresh | Re-reads the project |
| Open Settings | Opens this extension's settings |
| Show Log | Opens the Day output channel |
| Toggle Keep App Running After Script | Flips `day.script.keepAppRunning` |

Per-target **Run**, **Stop**, and **Restart** appear as inline buttons on a target row rather than
in the palette.

## Settings

| Setting | Default | What it controls |
|---|---|---|
| `day.cliPath` | `day` | Path to the CLI. See [how it resolves](./troubleshooting#how-the-cli-is-resolved) when left at the default. |
| `day.defaultProfile` | `debug` | Build mode for a new workspace |
| `day.defaultLocale` | `""` | Default `--locale`; empty means the app or system default |
| `day.verbose` | `false` | Run builds and launches with `--verbose`, showing every sub-command they execute |
| `day.logLevel` | `trace` | `DAY_LOG` level passed to every launch as `--env`; a `DAY_LOG` in `day.extraEnv` wins |
| `day.extraEnv` | `{}` | `KEY=VALUE` pairs passed to every launch as `--env` |
| `day.ohosNdkHome` | `""` | OpenHarmony NDK `native` directory for `harmony-arkui`; empty auto-detects |
| `day.script.keepAppRunning` | `true` | Keep the app alive after its dayscript finishes |
| `day.mcp.enabled` | `true` | Register Day's MCP server for agent mode |

## Task properties

Tasks of type `day` accept:

| Property | Required | Values |
|---|---|---|
| `command` | yes | `build` or `launch` |
| `target` | yes | A target id, e.g. `macos-appkit` |
| `profile` | no | `debug` or `release` |
| `locale` | no | A BCP-47 tag |
| `script` | no | Path to a dayscript, relative to the project |
| `project` | no | Project directory, for multi-root workspaces |
| `keepAlive` | no | Overrides `day.script.keepAppRunning` for this task |

Two problem matchers ship with it: `$day-rustc` for a one-shot build, and `$day-rustc-watch` for a
long-running task that rebuilds.

## Launch attributes

Debug configurations of type `day` take `target`, `profile`, `locale`, `script`, `keepAlive`, and
`project` — the same set as tasks. Omitting `target` launches whatever is ticked in the Day view.

## What lives elsewhere

The extension adds no build logic of its own; it runs the CLI and shows you the result. For the
underlying behavior:

- [CLI reference](https://daybrite.dev/docs/cli/) — every subcommand and flag
- [Platforms](https://daybrite.dev/docs/platforms/) — what each target builds and needs
- [dayscript](https://daybrite.dev/docs/dayscript/) — the script format and its steps
- [Packaging](https://daybrite.dev/docs/packaging/) — `day pack`, signing, and distribution
- [Day for agents](https://daybrite.dev/docs/for-agents/) — the MCP tools
