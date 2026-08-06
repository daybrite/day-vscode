---
title: Getting started
description: Open a Day project, pick targets, run them side by side, and wire builds into tasks and the debugger.
order: 2
section: Extension
---

# Getting started

This page assumes you have a Day project. If you don't,
[`day new app`](https://daybrite.dev/docs/getting-started/) scaffolds one in a few seconds, and you
can also run it from here with **Day: New Project…**.

## Open a project

Open any folder containing a `Day.toml`. The extension activates on that file, reads the project
with `day metadata --json`, and fills the **Day** view in the activity bar:

- the project, with its app id
- **Configuration** — build mode, locale, and dayscript
- **Targets** — every entry in your `Day.toml`, with the ones this host cannot build shown disabled

A macOS host cannot build `windows-xaml`, so that row is greyed with the reason. Which targets
exist, and what each one needs, is documented under
[Platforms](https://daybrite.dev/docs/platforms/).

## Run one target, or several

Tick a target and press **Run** in the view title bar. Each target launches as a VS Code **task** in
its own terminal, so output keeps its colors and stays separated per target. Tick two and both run
at once; each row gets its own stop and restart buttons, and the status bar shows how many are
live.

**Build** does the same without launching, which is what you want when you only care about
compile errors — they arrive through the `$rustc` problem matcher and land in the Problems panel.

## Set the build mode, locale, and script

The Configuration section edits the three flags most runs need:

| Row | Flag it sets | Notes |
|---|---|---|
| Build mode | `--profile debug\|release` | Defaults to `day.defaultProfile`. |
| Locale | `--locale <tag>` | Empty means the app or system default. See [Localization](https://daybrite.dev/docs/localization/). |
| Dayscript | `--script <file>` | Any `.yaml` under `dayscript/`. See [dayscript](https://daybrite.dev/docs/dayscript/). |

A run with a dayscript keeps the app alive after the script finishes, so you can extend the script
and drive the live app again. Turn that off with **Day: Toggle Keep App Running After Script**, or
per task with `"keepAlive": false`.

## Tasks and launch configurations

Every target is available as a task without any configuration on your part — open the command
palette and choose **Tasks: Run Task → day**. To pin one to <kbd>⌘⇧B</kbd> or a keybinding, write it
into `.vscode/tasks.json`:

```json
{
  "type": "day",
  "command": "launch",
  "target": "macos-appkit",
  "profile": "debug",
  "script": "dayscript/smoke.yaml",
  "problemMatcher": ["$day-rustc"]
}
```

For <kbd>F5</kbd>, add a launch configuration of type `day`. Omit `target` and it launches whatever
is ticked in the Day view:

```json
{
  "type": "day",
  "request": "launch",
  "name": "Day: Run",
  "target": "macos-appkit"
}
```

## Check your toolchains

**Day: Doctor (check toolchains)** runs `day doctor` and prints a per-toolkit report: what is
installed, what is missing, and how to install it. Run it before filing a build failure — most
"it won't build" reports are a missing SDK, and doctor names it.

## Let an agent drive it

With `day.mcp.enabled` on (the default), the extension registers Day's MCP server with VS Code's
agent mode, so an agent can build, launch, drive a running app, and read back screenshots. The tool
list and what each one does live in [Day for
agents](https://daybrite.dev/docs/for-agents/).

## Next

- [Commands and settings](./reference) — the full surface this extension adds
- [Troubleshooting](./troubleshooting) — when the view is empty or a build won't start
- [Project structure](https://daybrite.dev/docs/project-structure/) — what `day new app` generated
