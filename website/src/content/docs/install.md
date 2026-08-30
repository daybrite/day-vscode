---
title: Install and update
description: Install the Day extension from the VS Code Marketplace — or a release .vsix, or source — keep it current, and check that it found your day CLI.
order: 1
section: Extension
---

# Install and update

The extension drives the `day` CLI, but you do not have to arrange one first — it can build its
own. Install the extension, then run **Day: Install the day CLI…** and pick *Build it from source*.
[Getting started on daybrite.dev](https://daybrite.dev/docs/getting-started/) covers the CLI at
length, and the toolchains each target needs.

## From the Marketplace

**[Get it on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode)** — the route to take unless you have a
reason not to. VS Code updates it from there without you doing anything.

[![VS Code Marketplace version](https://vsmarketplacebadges.dev/version-short/daybrite.day-vscode.svg?style=flat-square&color=1C6E7E)](https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode)

Three ways in, all the same extension:

- Search for **Day** in the Extensions view (<kbd>⇧⌘X</kbd> / <kbd>Ctrl+Shift+X</kbd>)
- Open the listing: [daybrite.day-vscode](https://marketplace.visualstudio.com/items?itemName=daybrite.day-vscode)
- One line in a terminal:

```bash
code --install-extension daybrite.day-vscode
```

The two routes below exist for trying a build the Marketplace does not have yet, and for working
on the extension itself. Neither auto-updates.

## From a release build

Every tagged build also attaches a `.vsix`, which is the way to try something before it is
published. Its URL stays the same across versions:

```bash
curl -fLO https://github.com/daybrite/day-vscode/releases/latest/download/day-vscode.vsix
code --install-extension day-vscode.vsix
```

A `.vsix` install does **not** auto-update — re-run those two commands to move to a newer build,
and `--install-extension` replaces the installed copy in place.

## From source

```bash
git clone https://github.com/daybrite/day-vscode
cd day-vscode
npm install
npm run bundle
npx @vscode/vsce package -o day-vscode.vsix
code --install-extension day-vscode.vsix
```

Press <kbd>F5</kbd> in that checkout to launch an Extension Development Host instead, which is the
faster loop when you are changing the extension itself.

## Version channels

The minor version says which channel a build belongs to: **even minors are stable** (0.4.x), **odd
minors are pre-release** (0.5.x). The version alone tells you which one you are on.

## Getting the CLI

The extension needs a `day` CLI to do anything. **Day: Install the day CLI…** offers every route,
and the walkthrough's first step is the same command.

**Build it from source** is the route the extension manages itself. It runs `cargo install --git`
into the extension's own storage — nothing joins your `PATH`, and a `day` you installed yourself is
left exactly where it is. `day.cliVersion` decides what it builds:

| `day.cliVersion` | Builds |
|---|---|
| `main` | The tip of the development branch. **The default for now.** |
| `v0.3.0` | That tag. Any git tag or revision works. |
| *(empty)* | Whatever the default is — `main` today. |

`main` is the default because Day's tagged releases still trail the branch, and the extension
regularly needs a CLI change before it is released. That will change: once releases are regular
enough to be the better starting point, the default becomes the newest tagged release, and anyone
who wants the branch will keep it by having `main` written down.

It needs a Rust toolchain and takes a few minutes, which is the trade for being pinned and
self-contained. Every Day app is a Rust crate, so the toolchain is one you will need regardless.

Changing the version does not rebuild anything on its own — run the command again, and the new
build replaces the old one in place.

The other routes download a prebuilt binary onto your `PATH` instead, which is quicker and needs no
Rust. Use those if you only want to read a Day project, or if you would rather manage the CLI
yourself.

To remove a CLI the extension built, delete its folder — **Day: Show Log** prints the full path.

## Check the install

Open a folder containing a `Day.toml` and look for the Day icon in the activity bar. The view lists
your project and its targets. If it says *No Day project found* or reports a CLI error instead, the
[troubleshooting page](/docs/troubleshooting) starts with those two cases.

To confirm which CLI the extension resolved, run **Day: Show Log** from the command palette — the
Day output channel prints the full command line it uses.
