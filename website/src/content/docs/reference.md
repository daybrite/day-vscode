---
title: Commands and settings
description: Every command, setting, task property and launch attribute the extension contributes.
order: 6
section: Extension
---

# Commands and settings

Everything the extension adds to VS Code. What the underlying flags mean belongs to the CLI, and
[daybrite.dev/docs/cli](https://daybrite.dev/docs/cli/) documents that.

## Commands

All of these are under the **Day** category in the command palette.

### Running

| Command | What it does |
|---|---|
| Run Selected Targets | Launches every ticked target of the focused project, one task each |
| Run All Projects | Launches every ticked target in every project in the window |
| Build Selected Targets | Builds them without launching |
| Stop All | Stops every run this extension started |

### Choosing what runs

| Command | What it does |
|---|---|
| Select Targets | Ticks targets from a quick pick |
| Select Build Mode | debug or release |
| Select Locale | Sets `--locale` for later runs |
| Select Dayscript | Picks a `.yaml` under `dayscript/` |
| Select Log Level | Sets `DAY_LOG` for later launches |
| Select Project | Chooses which project the view and the Run button act on |
| Toggle Verbose Build Output | Flips `day.verbose` for the focused project |
| Toggle Keep App Running After Script | Flips `day.script.keepAppRunning` |

### Creating and checking

| Command | What it does |
|---|---|
| New Project… | The [scaffolding wizard](/docs/new-project) — an app, a piece or a part |
| Get Started with Day | Opens the walkthrough |
| Lint Project | Runs [`day lint`](/docs/linting) and shows the findings in the editor |
| Doctor (check toolchains) | Runs `day doctor` in a terminal |
| Refresh | Re-reads every project |
| Install the day CLI… | Offers the install routes for your platform |
| Open Settings | Opens this extension's settings |
| Show Log | Opens the Day output channel |

Per-target **Run**, **Stop**, **Restart** and **Build**, per-project **Run** and **Stop**, the **+**
that adds a device to a mobile target, and a device row's own **Play**, **Stop**, **Remove
Device** and **Start**/**Stop Simulator** (**Emulator** on Android) are inline buttons and
context-menu entries on their rows rather than palette commands.

Two more commands sit on the targets that carry a native project to open:

| Right-click | On | What it opens |
|---|---|---|
| Open in Android Studio | `android-mdc` | `platform/android`, the Gradle root |
| Open in Xcode | `ios-uikit`, on macOS | `platform/ios/DayApp.xcodeproj` |
| Open in Xcode | `macos-appkit`, on macOS | `platform/macos/DayApp.xcodeproj` |

Each is scaffolded source that `day new` wrote and your app owns, so none of them needs a build
first. A row offers the entry only when that directory is actually in the project.

## Settings

### Finding the CLI

| Setting | Default | What it controls |
|---|---|---|
| `day.cliVersion` | `main` | Which day-cli **Day: Install the day CLI…** builds from source. `main` = the development branch, anything else = that git tag or revision, empty = the default. `main` for now because releases still trail the branch; the default becomes the newest release once they do not. The build goes into the extension's own storage, not onto your `PATH`. |
| `day.cliPath` | `day` | Path to the CLI. See [how it resolves](/docs/troubleshooting#how-the-cli-is-resolved) when left at the default. |
| `day.cliSource` | `""` | Path to a `day` **source checkout**. Every CLI call becomes `cargo run` against it, so edits to the CLI reach the next build with no rebuild step. Takes precedence over `day.cliPath`. |

### Defaults for a run

| Setting | Default | What it controls |
|---|---|---|
| `day.defaultProfile` | `debug` | Build mode for a project the view has not seen before |
| `day.defaultLocale` | `""` | Default `--locale`; empty means the app or system default |
| `day.script.keepAppRunning` | `true` | Keep the app alive after its dayscript finishes, so you can extend the script and drive it again |

### Per project

These are folder-scoped: put them in one app's `.vscode/settings.json` and they apply to that app
alone, which is how several apps in one window run with different log levels or environments. The
Day view's Configuration rows write to the focused project's folder.

| Setting | Default | What it controls |
|---|---|---|
| `day.verbose` | `false` | Run with `--verbose`, showing every sub-command a build executes and its raw output |
| `day.logLevel` | `trace` | `DAY_LOG` level passed to every launch as `--env`; a `DAY_LOG` in `day.extraEnv` wins |
| `day.extraEnv` | `{}` | `KEY=VALUE` pairs passed to every launch as `--env` |
| `day.hideUnavailableTargets` | `true` | Leave the targets this host cannot build out of the **Targets** list; the heading says how many. Off lists them at the bottom, greyed out with the reason |

### Toolchain locations

Exported for **every** `day` command the extension runs — builds, launches, device listing, and
`day doctor` — so Doctor reports on the same toolchains your builds will use. That matters most
when VS Code was launched from the Dock or Start menu and inherited none of your shell's
environment.

| Setting | Default | What it controls |
|---|---|---|
| `day.androidSDKHome` | `""` | Android SDK directory. Exported as `ANDROID_HOME` **and** `ANDROID_SDK_ROOT`, with its `platform-tools/` and `emulator/` added to the task PATH. (`ANDROID_SDK_HOME` is a different, legacy variable and is deliberately not set.) |
| `day.androidNDKHome` | `""` | Android NDK directory for the `android-mdc` cross-compile. Exported as `ANDROID_NDK_HOME`. |
| `day.xcodeDeveloperDirectory` | `""` | The Xcode to build Apple targets with — the `.app` or its `Contents/Developer`. Exported as `DEVELOPER_DIR`, which `xcrun`, `xcodebuild` and `simctl` read directly. |
| `day.harmonyNDKHome` | `""` | OpenHarmony NDK `native` directory for `harmony-arkui`; empty auto-detects. Its `toolchains/` joins the task PATH so `hdc` is found. |

### The editor

| Setting | Default | What it controls |
|---|---|---|
| `day.followActiveEditor` | `true` | Focus the Day project the active editor's file belongs to |
| `day.newProject.openAfterCreate` | `ask` | What to do with a scaffolded project: `ask`, `open`, `openNewWindow` or `addToWorkspace` |
| `day.showWalkthroughOnStartup` | `false` | Open the walkthrough every time a window opens, rather than once per install |
| `day.debug.adapter` | `auto` | Which Rust debugger <kbd>F5</kbd> hands the binary to, or `none` to disable delegation |
| `day.mcp.enabled` | `true` | Register an MCP server for agent mode — one per Day project in the window, labelled `Day: <app title>` |

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

Every target is available as a task without any configuration on your part — **Tasks: Run Task →
day**. To pin one to <kbd>⌘⇧B</kbd> or a keybinding, write it into `.vscode/tasks.json`:

```json
{
  "type": "day",
  "command": "launch",
  "target": "macos-appkit",
  "profile": "debug",
  "script": "dayscript/demo.yaml",
  "problemMatcher": ["$day-rustc"]
}
```

## Launch attributes

Debug configurations of type `day` take `target`, `profile`, `locale`, `script`, `keepAlive` and
`project` — the same set as tasks. Omitting `target` launches whatever is ticked in the Day view.

```json
{
  "type": "day",
  "request": "launch",
  "name": "Day: Run",
  "target": "macos-appkit"
}
```

On a desktop target, **Start Debugging** builds the app and hands the binary to a Rust debugger you
already have installed, so breakpoints in `.rs` files are real. Mobile and web targets launch
without a debugger attached.

## What lives elsewhere

The extension adds no build logic of its own; it runs the CLI and shows you the result. For the
underlying behaviour:

- [CLI reference](https://daybrite.dev/docs/cli/) — every subcommand and flag
- [Platforms](https://daybrite.dev/docs/platforms/) — what each target builds and needs
- [dayscript](https://daybrite.dev/docs/dayscript/) — the script format and its steps
- [Packaging](https://daybrite.dev/docs/packaging/) — `day pack`, signing and distribution
- [Day for agents](https://daybrite.dev/docs/for-agents/) — the MCP tools
