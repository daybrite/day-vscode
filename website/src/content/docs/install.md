---
title: Install and update
description: Install the Day extension from a release .vsix or from source, keep it current, and check that it found your day CLI.
order: 1
section: Extension
---

# Install and update

The extension drives the `day` CLI. Install the CLI first — [Getting started on
daybrite.dev](https://daybrite.dev/docs/getting-started/) covers that and the toolchains each
target needs.

## From a release build

The extension is not on the Marketplace yet, so the `.vsix` attached to each release is the way in.
Its URL stays the same across versions:

```bash
curl -fLO https://github.com/daybrite/day-vscode/releases/latest/download/day-vscode.vsix
code --install-extension day-vscode.vsix
```

Every tagged build attaches one, and CI validates on every push that the package would pass the
Marketplace's own checks — so a release `.vsix` is the same artifact that will be published when
the listing goes live.

## Updating

A `.vsix` install does **not** auto-update. Re-run the two commands above to move to a newer build;
`--install-extension` replaces the installed copy in place. Watch
[Releases](https://github.com/daybrite/day-vscode/releases) to hear about new ones.

Once the Marketplace listing is live, VS Code will keep the extension current on its own, and this
page will say so.

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

## Check the install

Open a folder containing a `Day.toml` and look for the Day icon in the activity bar. The view lists
your project and its targets. If it says *No Day project found* or reports a CLI error instead, the
[troubleshooting page](./troubleshooting) starts with those two cases.

To confirm which CLI the extension resolved, run **Day: Show Log** from the command palette — the
Day output channel prints the full command line it uses.
