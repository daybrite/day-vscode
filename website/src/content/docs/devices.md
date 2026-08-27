---
title: Simulators, emulators and devices
description: Choosing where a mobile target lands — a booted simulator, a plugged-in phone, an emulator, or all of them.
order: 4
section: Extension
---

# Simulators, emulators and devices

A desktop target has one obvious place to run: this machine. A mobile target does not — you might
have two simulators booted, a phone plugged in, and an emulator running, all at once.

So `ios-uikit`, `android-mdc` and `harmony-arkui` expand in the Day view to a **Device** row.

## Picking one

Click the Device row. The picker opens straight away and spins while the CLI looks, so the click
always feels like it did something — enumerating simulators and phones takes a moment.

You will see:

- every **booted simulator**, **connected phone** and **running emulator** for that platform
- any **simulator or AVD that exists but is not running**, which the picker offers to start
- **All connected**, the default

Each device carries the flag that selects it, so iOS picks the right one of `--ios-simulator` and
`--ios-device` on its own. Nothing is guessed by the extension.

## All connected is the default

Leave it alone and a launch goes to *every* runtime of that kind it can see. That is usually what
you want when you have exactly one, and it is what makes a capture sweep across several simulators
work. Name a device when you mean one in particular.

## Starting a simulator that is not running

iOS cannot install onto a shut-down simulator, so picking one used to be a dead end. Now the picker
offers it, starts it for you, and selects it once it is ready. If it is still booting when the CLI
answers, the target stays on its default rather than pinning a device the next launch would fail
against.

## One platform at a time

Opening the iOS picker asks about iOS only. It does not run `adb`, and the Android picker does not
run `simctl`. Beyond being faster, this matters because `adb` starts a background server the moment
it is invoked, and taking a look at your simulators is no reason to start one.

## What it needs installed

The picker shows what the CLI can see, so an empty list usually means a missing SDK rather than a
missing device:

| Target | Needs | Where to set it |
|---|---|---|
| `ios-uikit` | Xcode, and a booted simulator or a trusted device | `day.developerDir` |
| `android-mdc` | The Android SDK, with `platform-tools` | `day.androidSdkHome` |
| `harmony-arkui` | The OpenHarmony SDK, with `hdc` | `day.ohosNdkHome` |

Those settings are exported for every `day` command the extension runs, including
**Day: Doctor** — so Doctor reports on the same toolchains your builds will use. That matters most
when VS Code was launched from the Dock or Start menu and inherited none of your shell's
environment.

Run **Day: Doctor (check toolchains)** first if the list is empty; it names what is missing.

## From a terminal

The same enumeration the picker uses:

```bash
day devices list -p ios-uikit
day devices boot -p ios-uikit "iPhone 16 Pro"
day launch -p ios-uikit --ios-simulator "iPhone 16 Pro"
```

See the [CLI reference](https://daybrite.dev/docs/cli/) for every flag, and
[Platforms](https://daybrite.dev/docs/platforms/) for what each mobile target expects.
