---
title: Troubleshooting
description: What to check when the Day view is empty, the CLI isn't found, a target is disabled, or a build won't start.
order: 3
section: Extension
---

# Troubleshooting

Start with **Day: Show Log**. The Day output channel prints the exact command the extension ran and
the error it got back, which answers most of the questions below in one line.

## "No Day project found in this workspace"

The extension activates on a `Day.toml` anywhere in the open folder. This message means it found
none.

- Open the folder that *contains* `Day.toml`, not its parent. A workspace two levels up will not
  match.
- In a multi-root workspace, run **Day: Select Project** to choose between the projects it did find.
- After adding a `Day.toml` to an already-open folder, run **Day: Refresh**.

## "A Day project was found, but the day CLI couldn't load it"

The manifest is there and `day metadata --json` failed. The output channel has the command and the
error. Common causes:

**The CLI isn't installed or isn't on `PATH`.** Check with `day version` in the same terminal
environment VS Code sees. If that fails, install it — see [Getting
started](https://daybrite.dev/docs/getting-started/) — or point the extension at the binary
directly:

```json
{ "day.cliPath": "/Users/you/.cargo/bin/day" }
```

**VS Code has a different `PATH` than your shell.** Launching VS Code from the Dock or Start menu
gives it the login environment, which often lacks `~/.cargo/bin`. Either set `day.cliPath` to an
absolute path, or start VS Code from a shell where `day` works (`code .`).

**The manifest doesn't parse.** Run `day lint` in the project — it validates `Day.toml` and reports
unknown targets and override tables. The [CLI reference](https://daybrite.dev/docs/cli/) covers what
it checks.

### How the CLI is resolved

Knowing the order helps when the wrong binary is picked up:

1. `day.cliPath` set to anything other than the default `day` is used verbatim.
2. Otherwise, if the workspace is inside the Day repository, `cargo run -q -p day-cli --`.
3. Otherwise, if a `day/` checkout sits beside the extension's own source, that repo via
   `--manifest-path`.
4. Otherwise `day`, expected on `PATH`.

Steps 2 and 3 build from source on the first run, which takes minutes and looks like a hang. The
output channel shows the `cargo` invocation, so you can tell that case apart.

## A target is greyed out

Targets your host cannot build are disabled with the reason in the row — `windows-xaml` needs a
Windows host, `macos-appkit` needs a Mac. This is not a configuration problem: those toolkits build
only on their own OS. [Platforms](https://daybrite.dev/docs/platforms/) lists what each target
requires.

## A build fails on a toolchain

Run **Day: Doctor (check toolchains)**. It reports each toolkit's tools with install instructions
for whatever is missing, which is faster than reading a linker error. For HarmonyOS specifically,
set `day.ohosNdkHome` if the NDK isn't in one of the paths doctor probes.

## The run starts and immediately stops

Open the task's terminal — the CLI's own error is there. If the app launched and exited, that is
your app's behavior rather than the extension's; run the same command by hand to confirm:

```bash
day launch -p macos-appkit
```

Anything that reproduces outside VS Code belongs to the CLI or the app, and
[daybrite.dev/docs](https://daybrite.dev/docs/) is the place to look.

## The app stays running after its script finishes

That is deliberate: a scripted run keeps the app alive so you can extend the script and re-drive it
with `day drive`. Turn it off with **Day: Toggle Keep App Running After Script**, the
`day.script.keepAppRunning` setting, or `"keepAlive": false` on a task.

## Stopping strands a process

**Day: Stop All** stops every run the extension started. If something survives — a detached
launch, a crashed session — `day stop --all` clears the session file the CLI keeps under
`build/day/sessions.json`.

## Agent tools don't appear

`day.mcp.enabled` must be on (it is by default), and VS Code's agent mode has to be available in
your build. The tools come from `day mcp-server`, so the CLI has to resolve first: fix any CLI
error above and the tools follow. [Day for agents](https://daybrite.dev/docs/for-agents/) lists what
they do.

## Still stuck

Open an issue with the output channel's contents and `day doctor`'s report:
[github.com/daybrite/day-vscode/issues](https://github.com/daybrite/day-vscode/issues).
