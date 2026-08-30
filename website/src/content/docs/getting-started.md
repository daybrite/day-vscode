---
title: Getting started
description: From an empty editor to a Day app running on your machine, one step at a time.
order: 2
section: Extension
---

# Getting started

This page walks the whole first run: make a project, look at what the extension shows you, and
launch it. It assumes the extension is installed and the `day` CLI is on your PATH — if not, start
with [Install and update](/docs/install).

New to Day itself? [What Day is](https://daybrite.dev/docs/overview/) explains the framework in a
few minutes, and this page will still make sense without it.

## 1. Open the walkthrough

Press <kbd>⇧⌘P</kbd> (<kbd>Ctrl+Shift+P</kbd> on Windows and Linux) and run **Day: Get Started with
Day**. VS Code also offers it on its Welcome page the first time you install the extension.

<figure class="shot">
  <img class="only-dark" src="/img/docs/walkthrough-dark.png" alt="The Get started with Day walkthrough, open in VS Code" />
  <img class="only-light" src="/img/docs/walkthrough-light.png" alt="The Get started with Day walkthrough, open in VS Code" />
  <figcaption>Five steps, each with a button. You can come back to it at any time.</figcaption>
</figure>

The first step's button is the same command as the next section, so you can follow either.

## 2. Create a project

Run **Day: New Project…**. You will be asked what to build, what to call it, and which platforms it
should ship to — the questions come from your `day` CLI, so the platforms offered are the ones it
actually supports.

<figure class="shot">
  <img class="only-dark" src="/img/docs/new-targets-dark.png" alt="Choosing platform-toolkits, with the host's own target preselected" />
  <img class="only-light" src="/img/docs/new-targets-light.png" alt="Choosing platform-toolkits, with the host's own target preselected" />
  <figcaption>Your own machine's platform arrives ticked. The ones it cannot build are still
  offered — an app can ship to platforms you build on CI.</figcaption>
</figure>

[Creating a project](/docs/new-project) covers every question, and what a piece and a part are.

Already have a Day project? Just open its folder. The extension activates on `Day.toml`.

### Take the recommended extensions

Opening a scaffolded project, VS Code offers the extensions its `.vscode/extensions.json` names.
Take them — a Day app is a Rust crate, and this extension does not do that part:

| Extension | What it gives you |
|---|---|
| [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | The Rust language service — completion, go-to-definition, and errors as you type. Your `root()` is Rust; without it you are editing in the dark. |
| [Even Better TOML](https://marketplace.visualstudio.com/items?itemName=tamasfe.even-better-toml) | Validation and completion in `Day.toml` and `Cargo.toml`. |

This extension deliberately does not require them. It drives the `day` CLI — building, running,
linting, packaging — and none of that needs a language server, so nothing here forces one on a
machine that only has to run a Day app. The scaffold recommends them because *writing* one is
much better with them.

A bare `cargo check` works with no flags in a scaffolded app: the crate's default `mock` backend is
what lets rust-analyzer resolve the whole tree without you choosing a target first.

## 3. Read the Day view

Open the **Day** icon in the activity bar. It lists every Day project in the window, and under each
one:

- **Configuration** — build mode, locale, dayscript, log level and verbosity
- **Targets** — every entry in the project's `Day.toml`

<figure class="shot">
  <img class="only-dark" src="/img/docs/cockpit-dark.png" alt="The Day view showing a project, its configuration and its targets" />
  <img class="only-light" src="/img/docs/cockpit-light.png" alt="The Day view showing a project, its configuration and its targets" />
  <figcaption>The targets this machine can build. Mobile targets expand to a Device row.</figcaption>
</figure>

A macOS machine cannot build `windows-xaml`, so that row is left out and the **Targets** heading
says how many were hidden. Set `day.hideUnavailableTargets` to `false` to list them instead: they
sit at the bottom of the group, greyed out and giving the reason. Either way an app can ship to
platforms you only ever build on CI. What each target is, and what it needs installed, is covered
in [Platforms](https://daybrite.dev/docs/platforms/).

## 4. Run it

Tick a target's checkbox and press **Run** in the view's title bar.

<figure class="shot">
  <img class="only-dark" src="/img/docs/select-targets-dark.png" alt="Ticking targets to run" />
  <img class="only-light" src="/img/docs/select-targets-light.png" alt="Ticking targets to run" />
  <figcaption>Clicking the row selects it; only the checkbox toggles whether it runs. You can also
  tick several from <b>Day: Select Targets</b>.</figcaption>
</figure>

Each target launches as a VS Code **task** in its own terminal, so output keeps its colours and
stays separated per target. Tick two and both run at once — every row gets its own stop and restart
buttons, and the status bar shows how many are live.

**Build** does the same without launching, which is what you want when you only care about compile
errors. They arrive through the `$rustc` problem matcher and land in the Problems panel.

Running a mobile target? [Simulators, emulators and devices](/docs/devices) covers choosing which one
it lands on.

## 5. When something is missing

Every platform needs its own SDK, and the first build on a new machine is where you find out which
one you lack. **Day: Doctor (check toolchains)** checks them all.

<figure class="shot">
  <img class="only-dark" src="/img/docs/doctor-dark.png" alt="day doctor reporting the toolchains on this machine" />
  <img class="only-light" src="/img/docs/doctor-light.png" alt="day doctor reporting the toolchains on this machine" />
  <figcaption>A ✓ for what is installed, a ⚠ for what is not — with the command that installs
  it.</figcaption>
</figure>

Only a missing **build** prerequisite is ever an error. A warning means a toolkit you are not
building today is not fully set up, which is fine until you build it.

## What to look at next

- **[Creating a project](/docs/new-project)** — the wizard, in full
- **[Simulators, emulators and devices](/docs/devices)** — running on mobile
- **[Linting](/docs/linting)** — findings in the editor, with quick fixes
- **[Commands and settings](/docs/reference)** — everything the extension adds
- **[Troubleshooting](/docs/troubleshooting)** — when the view is empty or a build will not start

And on the framework itself:

- **[Your first app](https://daybrite.dev/docs/getting-started/)** — writing Day code
- **[Project structure](https://daybrite.dev/docs/project-structure/)** — what the scaffold made
- **[Pieces](https://daybrite.dev/docs/pieces/)** — the UI vocabulary
- **[dayscript](https://daybrite.dev/docs/dayscript/)** — driving a running app from a script
