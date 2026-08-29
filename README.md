<h1 align="center">
  <a href="https://daybrite.dev">
    <img width="120" alt="Day" src="https://raw.githubusercontent.com/daybrite/day-vscode/main/media/day-icon.png" />
  </a>
  <br />
  Day for VS Code
</h1>

<p align="center">
  <a aria-label="Latest release" href="https://github.com/daybrite/day-vscode/releases" target="_blank">
    <img alt="Latest release" src="https://img.shields.io/github/package-json/v/daybrite/day-vscode?style=flat-square&color=1C6E7E&labelColor=49505A" />
  </a>
  <a aria-label="Build status" href="https://github.com/daybrite/day-vscode/actions" target="_blank">
    <img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/daybrite/day-vscode/ci.yml?branch=main&style=flat-square&labelColor=49505A" />
  </a>
  <a aria-label="VS Code Marketplace version" href="https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode" target="_blank">
    <img alt="VS Code Marketplace version" src="https://vsmarketplacebadges.dev/version-short/daybrite.day-vscode.svg?style=flat-square&color=1C6E7E" />
  </a>
  <a aria-label="VS Code Marketplace installs" href="https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode" target="_blank">
    <img alt="VS Code Marketplace installs" src="https://vsmarketplacebadges.dev/installs-short/daybrite.day-vscode.svg?style=flat-square&color=1C6E7E" />
  </a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode"><b>Install from the VS Code Marketplace</b></a>
  <br />
  <sub>or <code>code --install-extension daybrite.day-vscode</code></sub>
</p>

<p align="center">
  <a href="https://vscode.daybrite.dev/docs/install">Install</a> &nbsp;&mdash;&nbsp;
  <a href="https://vscode.daybrite.dev/docs/getting-started">Get started</a> &nbsp;&mdash;&nbsp;
  <a href="https://vscode.daybrite.dev/docs/troubleshooting">Troubleshooting</a> &nbsp;&mdash;&nbsp;
  <a href="https://vscode.daybrite.dev/screenshots">Screenshots</a> &nbsp;&mdash;&nbsp;
  <a href="https://daybrite.dev/docs">Day docs</a>
</p>

<br />

[Day](https://daybrite.dev) builds one app in Rust and ships it as a real native app on macOS,
Windows, Linux, iOS, Android, HarmonyOS and the web, each one drawn with that platform's own
widgets. This extension puts that loop in your editor: pick the platforms, press Run, and watch
them build and launch side by side.

<br />

## Run it on every platform at once

<img alt="The Day view listing a project, its targets and its devices, beside a Rust file" align="right" width="45%" src="https://raw.githubusercontent.com/daybrite/day-vscode/main/media/screenshot-cockpit.png" />

The **Day** view lists every project in the window and the platforms each one ships to. Tick the
ones you want and press Run.

- Each target builds in its own terminal, and stops and restarts on its own.
- Targets your machine cannot build are shown greyed, rather than hidden.
- Mobile targets expand to a **Device** row — a booted simulator, a plugged-in phone, an emulator,
  or every one at once.
- Open a dozen apps together: each keeps its own targets, build mode, locale and log level.

<br clear="right" />

## Start a project without leaving the editor

<img alt="Choosing platform-toolkits in the New Project wizard" align="right" width="45%" src="https://raw.githubusercontent.com/daybrite/day-vscode/main/media/screenshot-new-project.png" />

**Day: New Project** scaffolds an app, a piece or a part, one question at a time, with Back at
every step.

- The questions come from the CLI itself, so the platforms offered are exactly the ones your `day`
  supports.
- Your own machine's platform arrives preselected.
- New to Day? The **Get started with Day** walkthrough on VS Code's Welcome page takes it from the
  top.

<br clear="right" />

## Catch problems where they happen

<img alt="day doctor reporting the toolchains installed on this machine" align="right" width="45%" src="https://raw.githubusercontent.com/daybrite/day-vscode/main/media/screenshot-doctor.png" />

- **Day: Doctor** checks the toolchain for every platform and prints the command that installs
  whatever is missing.
- **Day: Lint Project** draws findings on the lines they name — a missing translation, a route
  nothing declares, an undeclared permission — with quick fixes where the repair is unambiguous.
- **Day: Clean Project** removes every build artifact — `build/`, `target/`, and the platform
  scaffolds' generated outputs — via `day clean`, confirming first and reporting the space it
  reclaimed.
- **F5** builds a desktop target and hands the binary to a Rust debugger you already have, so
  breakpoints in `.rs` files are real ones.

<br clear="right" />

## Built for agent mode

In a Day workspace the extension registers the **Day MCP server** with VS Code's agent mode, so an
agent can inspect the project, build and launch it, then drive the running app and take
screenshots — on every platform it targets. Ask for something like:

> Add a configuration page, relaunch on all targets, and show me screenshots.

## Requirements

VS Code 1.101 or newer, and the [`day` CLI](https://daybrite.dev/docs/cli):

```bash
cargo install day-cli
```

Each platform needs its own SDK — Xcode, a JDK and the Android SDK, GTK 4 or Qt 6. Run
**Day: Doctor** and it will name what is missing for the platforms you picked, with the command to
install it.

## Learn more

- **[Installing and updating](https://vscode.daybrite.dev/docs/install)** — including how to point
  the extension at a particular `day` binary or a local checkout.
- **[Getting started](https://vscode.daybrite.dev/docs/getting-started)** — a first app, from
  scaffold to a running window.
- **[Reference](https://vscode.daybrite.dev/docs/reference)** — every command and setting,
  including the per-project ones and the toolchain paths.
- **[Troubleshooting](https://vscode.daybrite.dev/docs/troubleshooting)** — when a build or a
  launch does not go as planned.
- **[Day documentation](https://daybrite.dev/docs)** — the framework itself: pieces, layout,
  navigation, localization and packaging.

## Contributing

Bugs and ideas are welcome in [issues](https://github.com/daybrite/day-vscode/issues).
[CONTRIBUTING.md](https://github.com/daybrite/day-vscode/blob/main/CONTRIBUTING.md) covers building
the extension from source and running its tests.
