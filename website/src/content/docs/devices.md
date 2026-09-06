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

## Choosing which ones run

Every device row has a checkbox. The target's Play — and the project's Run — launch onto the
**ticked** devices, one task and one terminal each, so you can watch two simulators side by side
while a third stays configured but idle.

The target's own checkbox is the all-or-nothing switch for the devices under it: ticking it ticks
them all, unticking it clears them. Untick the last device and the target unticks itself, since
there is nothing left for it to launch onto.

A partly ticked target reads **`1 of 2 devices`** in its row. VS Code's tree checkboxes are
two-state — there is no half-ticked box to show — so the count is where partial selection is
visible. The box itself stays ticked while any device is, which is exactly when the target still
runs.

## Running them

Each device row has its own **Play**, which launches on that device alone whether or not it is
ticked. Remove a device with **Remove Device** on its right-click menu; removing one that is
running stops it first.

Play first asks the CLI where the device stands, which is `adb` or `simctl` and can take a
few seconds. For that long the row reads `checking…` with a spinner and its Play button is
put away, so the click has visibly landed and a second one cannot queue a second launch.

Press Play on a simulator or emulator that is not running and you are asked first:

> The "iPad (A16)" iOS simulator is not currently running.

**Launch It** starts it, waits for it to finish booting, and then runs the app on it. **Cancel**
leaves everything as it was. Without the question this was a build's worth of waiting followed by
"not connected" in the terminal, for something the row had been saying all along. A plugged-in
phone is never asked about — there is nothing to start — and neither is a target whose devices
have not been enumerated yet.

## Starting and stopping the device itself

A simulator or emulator row's right-click menu offers **Start Simulator** when it is not running
and **Stop Simulator** when it is — **Start Emulator** and **Stop Emulator** on Android — so a
device you configured once is one click from being up, and one click from giving back the memory
it holds. Stopping also stops any app running on it first, since a run left attached to a device
that has gone has no row to stop it from.

Physical phones get neither entry. There is no software to start, and unplugging one is the real
way to stop it.

The row itself says which state it is in, so the menu never surprises you: `connected`,
`not running`, or `not found` for a simulator that has since been deleted. That reading comes from
the CLI, and the extension asks only about the platform whose rows are on screen.

An Android emulator that comes back on a different adb serial keeps its row. The serial is a
console port rather than a name — it slides when another emulator holds it — so the row remembers
the AVD and follows the emulator to wherever it lands, keeping its place in the list and its tick.

A row that predates that will say `not found` once its emulator stops, since a serial on its own
names nothing. Its menu offers **Start Emulator…** — with the ellipsis, because it asks which AVD
the row is — and it only asks once: the answer is stored, and from then on the row behaves like
any other. Rows whose emulator is running are repaired without being asked, the moment the
extension next looks at that platform.

## An empty list means every connected device

A target with no devices configured launches onto *every* runtime of that kind the CLI can see —
its own default. That is usually what you want when you have exactly one, and it is what makes a
capture sweep across several simulators work. Add devices when you mean particular ones.

## Starting a simulator that is not running

iOS cannot install onto a shut-down simulator, so picking one used to be a dead end. Now the picker
offers it and starts it for you.

The row appears **immediately**, reading `Booting…` with a spinner, and stays there while the
device comes up — the CLI waits for the real thing (`simctl bootstatus` on iOS,
`sys.boot_completed` on Android), not merely for the boot to have been asked for. An emulator that
lands on a different adb serial than expected takes its row with it.

If it does not start, you get the CLI's own diagnosis in a dialog — for an emulator that includes
the tail of its log — and the row reads `failed to start` until the device is actually seen. The
row stays, so **Start Emulator** on it is the retry.

A slow emulator is the interesting case, because "gave up waiting" and "never coming" are not the
same thing. After a boot the extension keeps looking for that one device for a few minutes, so an
emulator that arrives late corrects its own row without being asked. It watches the device it was
told to start and nothing else: enumerating Android starts an `adb` server that outlives the
command, and putting that on a timer would keep one alive on every machine with a Day project
open, including those whose author is working on iOS.

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
day devices shutdown -p ios-uikit "iPhone 16 Pro"
```

See the [CLI reference](https://daybrite.dev/docs/cli/) for every flag, and
[Platforms](https://daybrite.dev/docs/platforms/) for what each mobile target expects.
