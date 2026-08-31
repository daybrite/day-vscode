---
title: Simulators, emulators and devices
description: Choosing where a mobile target lands — a booted simulator, a plugged-in phone, an emulator, or all of them.
order: 4
section: Extension
---

# Simulators, emulators and devices

A desktop target has one obvious place to run: this machine. A mobile target does not — you might
have two simulators booted, a phone plugged in, and an emulator running, all at once.

So `ios-uikit`, `android-mdc` and `harmony-arkui` each hold a **list of devices** in the Day view,
which you build up yourself and which stays put between sessions.

## Adding one

Hover a mobile target row and press **+**. The picker opens straight away and spins while the CLI
looks, so the click always feels like it did something — enumerating simulators and phones takes a
moment.

You will see:

- every **booted simulator**, **connected phone** and **running emulator** for that platform
- any **simulator or AVD that exists but is not running**, which the picker offers to start

Devices already on the list are shown with a check and cannot be added twice. Each device carries
the flag that selects it, so iOS picks the right one of `--ios-simulator` and `--ios-device` on its
own. Nothing is guessed by the extension.

The device you add becomes a row under the target. It stays there whether or not that phone is
plugged in — the row says `connected`, `not running` or `not found` from whatever the extension
last learned, rather than disappearing when you unplug something.

## Running them

Each device row has its own **Play**, which launches on that device alone. The target's own Play
launches on **every** device configured under it, one task and one terminal each, so you can watch
two simulators side by side.

Remove a device with **Remove Device** on its right-click menu. Removing one that is running stops
it first.

## An empty list means every connected device

A target with no devices configured launches onto *every* runtime of that kind the CLI can see —
its own default. That is usually what you want when you have exactly one, and it is what makes a
capture sweep across several simulators work. Add devices when you mean particular ones.

## Starting a simulator that is not running

iOS cannot install onto a shut-down simulator, so picking one used to be a dead end. Now the picker
offers it, starts it for you, and adds it once it is ready. If it is still booting when the CLI
answers, nothing is added rather than storing a device whose launch flag is not yet known.

## One platform at a time

Opening the iOS picker asks about iOS only. It does not run `adb`, and the Android picker does not
run `simctl`. Beyond being faster, this matters because `adb` starts a background server the moment
it is invoked, and taking a look at your simulators is no reason to start one.

## What it needs installed

The picker shows what the CLI can see, so an empty list usually means a missing SDK rather than a
missing device:

| Target | Needs | Where to set it |
|---|---|---|
| `ios-uikit` | Xcode, and a booted simulator or a trusted device | `day.xcodeDeveloperDirectory` |
| `android-mdc` | The Android SDK, with `platform-tools` | `day.androidSDKHome` |
| `harmony-arkui` | The OpenHarmony SDK, with `hdc` | `day.harmonyNDKHome` |

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
