---
title: Running tests
description: Run a project's #[day::test] functions from the editor, on every target you have ticked, and debug one on a desktop target.
order: 6
section: Extension
---

# Running tests

A Day app's tests run inside the app, on a real toolkit: a function marked `#[day::test]` returns a
`Case`, a page plus a drive against it or a headless body, and
[`day test`](https://daybrite.dev/docs/testing/) builds the app for a target, launches it, and runs
the cases in it. The extension puts those tests where VS Code puts every test: the **Test
Explorer**, and the icon in the gutter beside each test function.

## Where the tests appear

Open the Testing view (the beaker in the activity bar). **Day Tests** lists every project in the
window, each file that declares a test, each test function by the name its `Case` gives it, and
under each test one row per target the test will run on.

Those target rows follow the Day view: tick `ios-uikit` and every test gains an `ios-uikit` row,
untick it and the row goes. A mobile target with devices configured gets a row per ticked device. A
project with nothing ticked lists this machine's own desktop toolkit, which is what a bare
`day test` runs.

The tests are found by reading the Rust sources for the attribute, in an app's spelling
(`#[day::test]`) and the framework's (`#[day_macros::test(day_core)]`), and named the way the
app names them: after the function, with hyphens for underscores (`button_status` is
`button-status`). A test in a file outside every project
runs in the focused project, which is how the `day` checkout's own cases, declared in
`crates/day-pieces` beside no `Day.toml`, run in `apps/conformance`.

## Running one, or all of them

- The **play icon in the gutter** beside a test function runs it on every target under it. One
  click, every enabled toolkit.
- A target row's own play icon runs the test on that target alone.
- A file's or a project's play icon runs everything beneath it.
- **Day: Run Tests** runs the focused project's tests on its ticked targets; it is also on the Day
  view's title bar and on each project row. A target row's **Run Tests** runs the project's tests
  on that target.
- **Run on target…**, the Test Explorer's second run profile (the dropdown beside the play icon,
  or **Run with profile…**), asks which targets to use for this one run without changing the ticks.
  **Day: Run Tests on Target…** is the same from the palette.

Each project and target is one `day test`: the build, the launch, and the run, with the output in
the Test Results panel. Results land on the target rows, and roll up: a test shows failed if it
failed on any target, and its rows say which.

A failed test's message is the assertion that failed, as `day test` printed it, with a link to the
test's `failed.png`, the screen at the moment it failed. `day.tests.shots` chooses which captures
a run keeps: `on-failure` by default, `always` to keep every `d.shot(..)` a test takes, `never`.

## Debugging a test

**Debug Test** (the gutter icon's menu, or the debug icon on a row) works on a desktop target
with a Rust debugger extension installed, the same way F5 does: the app is built, handed to LLDB
DAP, CodeLLDB or C/C++ with the environment a normal launch gets, and the tests are then run inside
it. A breakpoint in the test's page or drive, or anywhere in the app, stops there; the test run
waits for as long as you do (a debugged run sets no per-test time limit), and finishes when
you continue. The session ends when the report is
in.

A device or browser target has no debugger to hand the app to, and a test asked to debug there runs
as it would from the play icon, which the output says.

## From a terminal

```sh
day test -p macos-appkit                 # every test, on one target
day test -p linux-gtk 'text-field-*'     # a glob over test names
day test -p ios-uikit --list             # what the built app registers
```

The extension's [reference](/docs/reference) lists the commands and the setting; the framework's
[testing guide](https://daybrite.dev/docs/testing/) covers writing a `Case`, the drive vocabulary,
and what a run leaves behind.
