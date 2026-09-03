## Unreleased

- **Play on a stopped simulator offers to start it.** A device row's Play used to build the app
  and then fail in the terminal with the CLI's "not connected", for a device the row had been
  reporting as `not running` the whole time. It now asks — *The "iPad (A16)" iOS simulator is not
  currently running.* — and **Launch It** starts the device, waits for it to boot, and runs on it.
  A physical phone is never asked about, and neither is a target whose devices have not been
  enumerated yet: both launch the way they always did.
- **A device row can start and stop the device itself.** Right-click a simulator or emulator under
  a mobile target for **Start Simulator** when it is not running and **Stop Simulator** when it is
  — **Start Emulator** and **Stop Emulator** on Android. Stopping stops any app running on it
  first. Physical phones get neither entry: there is nothing to start, and unplugging one is the
  real way to stop it. Needs a `day` with `devices shutdown`.
- Device rows now say `connected` / `not running` / `not found` as soon as they are drawn. The
  listing behind those words was only ever fetched by opening the **+** picker, so a row that had
  never been asked about showed nothing at all.
- An Android emulator restarted onto a different adb serial keeps its row, its place in the list
  and its tick. A serial is a console port rather than a name — it slides when another emulator
  holds it — so a row now remembers the AVD and follows the emulator to wherever it lands.
- Booting an AVD from the **+** picker adds it. It never did: Android boots an AVD by name and
  then reports it by serial, so the picker looked for a device id that could not appear and always
  ended in "add it once it finishes booting", for a device that had already finished.
- Android emulators read as the AVD they are running — `Pixel_9_API_36 (emulator-5554)` rather
  than `Emulator (emulator-5554)`, which named only a console port — and an AVD that is already up
  no longer appears under the picker's **Not running** heading as a second device to start.

- **An installed `day` is no longer a prerequisite.** **Day: Install the day CLI…** — and the
  walkthrough's new first step — can build one from source with `cargo install --git`, into the
  extension's own storage. Nothing joins your `PATH`, a `day` you installed yourself is untouched,
  and deleting the storage folder undoes it. `resolveCli` finds it after the checkouts and ahead of
  `PATH`.
- **`day.cliVersion`** decides what that builds: `main`, or any git tag or revision. It defaults to
  `main`, because releases still trail the branch and the extension regularly needs a CLI change
  before one ships — version skew becomes a setting rather than a support thread. Selecting the
  newest tagged release is implemented and tested but switched off behind
  `DEFAULT_TO_NEWEST_RELEASE`; it becomes the default once releases are regular enough to be the
  better starting point. The build needs a Rust toolchain, which every Day app needs anyway; the
  prebuilt-binary routes are still offered for anyone who would rather not compile.
- **Breaking — four toolchain settings were renamed.** VS Code builds a setting's title from its
  key and offers no way to override it, so the titles could only be fixed by renaming:

  | Old | New | Now reads |
  |---|---|---|
  | `day.developerDir` | `day.xcodeDeveloperDirectory` | Day: Xcode Developer Directory |
  | `day.androidSdkHome` | `day.androidSDKHome` | Day: Android SDK Home |
  | `day.androidNdkHome` | `day.androidNDKHome` | Day: Android NDK Home |
  | `day.ohosNdkHome` | `day.harmonyNDKHome` | Day: Harmony NDK Home |

  The old keys are gone rather than deprecated, and VS Code ignores a setting it does not know —
  so a `settings.json` still naming one loses that toolchain path silently. Rename it and the
  export returns.
- Every Day setting now sits on one settings page, ordered from the ones people change often to
  the platform SDK paths most never touch. The **Scripts**, **Debugging** and **AI · Agents**
  sub-entries are gone: they hid three settings from anyone reading the Day page.
- Settings carry `keywords`, so searching for what a setting *does* finds it — `DEVELOPER_DIR`,
  `ANDROID_HOME`, `HarmonyOS`, `hdc`, `adb`, `DAY_LOG` — including the terms that cannot fit in a
  title.
- **Day: Clean Project** removes every build artifact of the selected project — `build/`,
  `target/`, and the platform scaffolds' generated outputs (gradle, hvigor, SwiftPM scratch) —
  by calling the new `day clean`, after a modal confirmation and after stopping the project's
  running targets. On the Projects rows' context menu, the panel's overflow menu, and the
  command palette; the status bar reports what was reclaimed.
- **Day: Lint Project** moved off the project row's inline buttons and into that same
  context menu, leaving Run and Stop as the row's only inline actions.
- Fixed the capture run on Windows: focusing a project by clicking its row left the pointer on it,
  and VS Code's hover for that row — the project's full path — then covered the target checkboxes
  beneath. Ticking a target clicked the tooltip instead, for thirty seconds. The pointer is parked
  away after a row click, and a blocked click now retries rather than waiting out its timeout.
- Fixed the capture run on all three platforms: it scaffolded a project, opened its `lib.rs`, and
  then closed every editor — which handed the cockpit to the NEW project on the way out, because
  focus follows the active editor. Run acts on the focused project, that one had nothing ticked,
  and the run silently never started. The fixture is made focused again at the moment it matters,
  and a run that never starts now fails in three minutes with the cockpit's contents in the
  message, rather than after thirty minutes of silence. The wizard also clears a scaffold left by
  a previous run, which `day new` otherwise refuses to overwrite.
- Fixed a flaky capture/e2e run: the extension's first call against a project is
  `day metadata --json`, which resolves the whole dependency graph through `cargo metadata`. On a
  freshly scaffolded fixture that means fetching, which can outlast the 30-second budget the
  extension gives it — and losing the race left the sidebar with no projects at all. The fixture
  now resolves its graph while it is being scaffolded, so the timed call starts warm.
- The screenshot gallery opens a capture full size, and moves in two directions from there: **←/→**
  show the same capture on another platform, **↑/↓** step through the run on the same one. Escape
  or the backdrop closes it, tiles open with Enter or Space, and a direction with nowhere to go is
  disabled rather than silently inert. A platform that missed a step is skipped rather than shown
  as an empty frame.
- The capture run now opens the scaffolded app's `lib.rs` in the editor, so the surfaces
  photographed after it frame real code instead of VS Code's watermark.
- Fixed: the macOS desktop capture sometimes framed a system permission panel — "Allow … to find
  devices on local networks" — instead of the app it exists to show. The run clears any pending
  system prompt before the shutter.
- Fixed: the macOS capture job idled for an hour after finishing its work. `day doctor` probes
  Android with `adb devices`, which forks a server daemon that inherits the step's stdout — and a
  GitHub step cannot finish while anything holds that pipe. The step now stops the daemon on the
  way out, and the harness exits explicitly once its results are on disk rather than waiting on a
  stray handle.
- The capture harness now drives **New Project** end to end on each of the three host platforms
  and photographs it: the walkthrough, the kind picker, the name step, the platform-toolkit picker
  — where the host's own target arrives preselected and the ones it cannot build say so — and the
  scaffolded app appearing in the Day view. The pictures land in the same `screenshots-<combo>`
  artifacts the website already builds its gallery from. A native folder dialog would have stopped
  this dead, so the harness turns on VS Code's own simple file dialog, which is a quick input it
  can type into.
- `scripts/dev.sh` / `dev.ps1` with no argument and no Day project to find used to stop with an
  error. That is what a fresh clone looks like, so they now install this repository's dependencies
  if `node_modules` is missing and open a window on the extension's welcome page instead — the
  same empty state, and the same **Create a Day Project** button, a first-time user sees. Running
  them from inside an app, or naming apps as arguments, is unchanged.
- **New Project asks the CLI what to ask.** The wizard now walks every question `day new` would
  ask — app, piece or part — reading them from the new `day new --describe`, so the extension no
  longer keeps its own copy of the target list, the toolkit list, or which questions a native
  piece needs. Steps have a **Back** button and a counter, blank optional fields fall through to
  the CLI's own defaults, and what happens after scaffolding (open here, new window, add to the
  workspace) is a setting, `day.newProject.openAfterCreate`, that defaults to asking. Needs a
  `day` CLI new enough to have `day new --describe`; without one the command says so.
- **A welcome page.** A `Get started with Day` walkthrough now appears on VS Code's Welcome
  page, with steps for creating a project, running it from the sidebar, checking toolchains, and
  linting — each with a button. It renders without activating the extension, which is what lets it
  reach someone who has no Day project yet, and **Day: Get Started with Day** reopens it. The
  empty Day view and an empty Explorer both offer **Create a Day Project** too.
- Fixed: **New Project** offered `windows-winui`, which is not a Day target, and omitted five that
  are — the picker now reads the target catalog. It also scaffolded into the day checkout instead
  of the folder you picked whenever `day.cliSource` was set.
- **Lint in the editor.** `Day: Lint Project` — the sidebar toolbar, the palette, or a project
  row's right-click menu — runs `day lint` on that project and draws its findings on the lines
  they name, in the Problems panel and in the file. Findings that name something that does not
  exist (a route nothing declares, an undeclared permission, an unknown target) come through as
  errors; coverage gaps and store copy as warnings. Where the CLI proposed a repair
  that is safe and unambiguous, it is offered as a **quick fix**, with **Fix all in file** when a
  file has more than one; applying one re-lints, so a stale repair can't undo the one before it.
  Each project owns its own diagnostics, so linting one app never clears another's. Requires a
  `day` CLI new enough to have `day lint --json`; without one the command reports and the sidebar
  is otherwise unaffected.
- **Pick the phone.** Mobile targets — `ios-uikit`, `android-mdc`, `harmony-arkui` — now expand in
  the sidebar to a **Device** row: choose a booted simulator, a plugged-in phone, an emulator, or
  **All connected**, which stays the default and is what every launch did before. The list comes
  from the new `day devices list --json`, and each device carries the flag that selects it, so iOS
  picks the right one of `--ios-simulator` / `--ios-device` on its own. Choosing a simulator that
  is not running offers to start it (`day devices boot`) and then selects it — iOS cannot install
  onto a shut-down simulator, so that used to be a dead end. The picker opens immediately and spins
  while the devices are found, and that target's Device row spins with it, rather than leaving the
  click with no feedback; Escape backs out at any point, including mid-query. Each target is
  queried on its own, so opening the Android picker takes 0.13s instead of 1.3s and never runs
  `simctl` or `hdc` — and opening the iOS one never starts an `adb` server. Requires a `day` CLI new enough to
  have `day devices`; without one the rows simply do not appear.
- Clicking a target row selects it instead of toggling whether it builds. Only the checkbox
  toggles now, the way every other checkbox tree in VS Code behaves — a row can be selected,
  expanded and right-clicked without flipping its state. `Toggle Target Selection` is on the row's
  right-click menu for anyone who found the checkbox a small target.
- Fixed: ticking a project's **Verbose** checkbox wrote to whichever project was focused rather
  than the one the row sits under.
- **Toolchain locations are settings now.** `day.androidSdkHome`, `day.androidNdkHome` and
  `day.developerDir` join `day.ohosNdkHome`, and all four are exported for every `day` command the
  extension runs — including `day doctor`, which previously opened a plain terminal and reported on
  whatever the login environment named rather than what builds here actually use. The Android SDK
  sets both `ANDROID_HOME` and `ANDROID_SDK_ROOT` and puts `platform-tools/` and `emulator/` on the
  task PATH, so `adb` and the emulator are found in a Dock-launched window; `day.developerDir`
  accepts either `Xcode.app` or its `Contents/Developer`.
- **Configuration moved inside each project.** Projects are now the sidebar's roots, each with its
  own `Configuration` and `Targets` groups, and a configuration row edits the project it sits under
  rather than whichever one is focused. Collapsed groups summarize — `debug · fr · demo.yaml`,
  `2 ticked · 1 running` — so a collapsed project still says what Run would do.

- **Many Day apps in one window.** The sidebar now lists every project it finds, each expanding to
  its own targets, and each keeping its own ticked targets, build mode, locale and dayscript — one
  app's selection no longer stands in for another's. Launches are tracked per project *and* target,
  so two apps building `macos-appkit` get their own terminals, run badges and stop buttons instead
  of one silently stopping the other; task names carry the project (`run macos-appkit (Day-Sketch)`)
  for the same reason. `Run` acts on the focused project, `Day: Run All Projects` launches every
  ticked target everywhere, and a project row has its own inline run/stop. The focused project
  follows the file you're editing — turn that off with `day.followActiveEditor`. `day.verbose`,
  `day.logLevel` and `day.extraEnv` became per-project settings, so apps can run at different log
  levels side by side; the sidebar's Verbose and Log level rows write to the focused project.
  `scripts/dev.sh` (and `dev.ps1`) take several projects:
  `scripts/dev.sh Day-Sketch Day-Showcase`.
- **`day.cliSource`** — point it at a `day` source checkout and every CLI call runs through
  `cargo run --manifest-path <path>/Cargo.toml -q -p day-cli --`, so a change to the CLI is compiled
  into the next build, launch or project scan with no rebuild step to remember. The dev launchers
  now set it instead of pinning a built binary. Needs `cargo` on the editor's PATH; without it the
  checkout's built binary is used and a warning says so.
- Project discovery loads up to eight projects at a time instead of one after another — a window
  holding two dozen apps spent about six seconds of activation waiting on a queue of one.
- **Log level** — every launch now passes `--env DAY_LOG=<level>`, `trace` by default, so a
  launched app shows everything it logs — the per-statement SQL from day-persistence included —
  in the task terminal (native targets) or the browser console (`web-dom`). Pick another level
  from the Day sidebar's Configuration section, `Day: Select Log Level` in the palette, or the
  `day.logLevel` setting; a `DAY_LOG` entry in `day.extraEnv` still wins.
- **Verbose** — run `day build` and `day launch` with `--verbose`, so the task terminal shows
  every sub-command they execute (cargo, gradle, xcodebuild, hvigor, adb, codesign, …) and its
  raw output instead of Day's status lines alone. Off by default; applies to tasks, the
  tree/status-bar runs built from them, and debug launches. Toggle it with the checkbox in the
  Day sidebar's Configuration section, `Day: Toggle Verbose Build Output` in the palette, or
  the `day.verbose` setting.
- **Run and Debug**: `Start Debugging` on a desktop target now stops on breakpoints in Rust. Day
  builds the app and hands the binary to a debugger you already have — LLDB DAP, CodeLLDB, or
  C/C++, probed in that order and pinnable with `day.debug.adapter` — passing the same launch
  environment `day launch` uses, so a stopped app still finds its images, vectors, fonts, and
  identity. Device and browser targets, `Run Without Debugging`, and hosts with no debugger
  installed keep launching through the Debug Console as before. Needs a `day` CLI that reports a
  `launch` plan in `day build --format json`. Put breakpoints in the library crate: `macos-appkit`
  builds through an Xcode host project that supplies its own `main`, so `src/main.rs` is not part of
  that binary and a breakpoint there never binds.
- `scripts/dev.ps1` — the Windows counterpart of `scripts/dev.sh`: opens both the app and the
  sibling `day/` checkout in one Extension Development Host, with the app's cargo resolution
  patched at that checkout.
- Both dev launchers take the Day project as their argument and work against any app, instead of
  defaulting to `Day-Showcase`. With no argument they use the nearest ancestor of the current
  directory holding a `Day.toml`, so running one from inside an app needs no argument.

- CLI resolution: when the extension runs from a `day-vscode/` source checkout that sits beside a
  `day/` repo, it now builds the CLI from that peer repo via `cargo run --manifest-path`, so a
  project opened from anywhere (e.g. a sibling `Day-Games/`) loads without an installed `day` on
  PATH — not only projects opened from inside the Day repo.
- A Day.toml found but unloadable no longer masquerades as "No Day project found": the sidebar
  shows a distinct message, a notification names the cause (e.g. the `day` CLI couldn't run), and
  the full attempted command and error go to a new **Day** output channel (`Day: Show Log`).

## 0.4.2

- Fixed: desktop apps launched with `--keep-alive` died when the VS Code task's terminal was
  disposed (pty SIGHUP to the process group) — detached launches now run in their own process
  group on every OS, so they survive like the mobile targets always did.
- Settings panel: Day's preferences are grouped into titled sections (Day / Scripts /
  AI · Agents) in the native Settings UI; a gear in the Day view title opens them filtered.
- `Day: Toggle Keep App Running After Script` command; the cockpit's script item shows a pin
  when keep-alive is on, and its hover toggles it in place.

## 0.4.0

- Agentic development: registers `day mcp-server` with VS Code (1.101+) for every Day
  workspace (`day.mcp.enabled`, default on) — agent mode gets ten `day_*` tools to build,
  launch, relaunch, stop, and DRIVE running apps, with screenshots returned as images.
- `Day: New Project…` — name → target multi-pick → folder, scaffolds with `day new` and opens
  the app (which now ships `AGENTS.md` + `.vscode/extensions.json`).

## 0.3.0

- Status-bar cockpit: run/stop toggle, a target item (short names + live spinner) opening a
  multi-select target picker, build mode, and a locale/dayscript context item — each with a
  rich hover that can run/stop/build any target directly.
- Vendored `$day-rustc` / `$day-rustc-watch` problem matchers (the stock `$rustc` name only
  exists when rust-analyzer is installed); attached to all day tasks, launches included.
- `resolveTask` reuses the incoming task definition verbatim, so hand-written `day` tasks in
  tasks.json (and `preLaunchTask` references) resolve correctly and fast.
- Day.toml validation: associates https://daybrite.dev/schema/day.toml.json (emitted by
  `day metadata --schema`) through Even Better TOML's schema associations.
- Hygiene: esbuild bundling, `engines.vscode ^1.101`, Restricted Mode / virtual workspace
  capability declarations, activation trimmed to `workspaceContains:**/Day.toml`.

# Changelog

## 0.2.0

- Day projects are now marked by a `Day.toml` manifest (replacing `day.yaml`) — requires a
  day-cli with the `day metadata` command.
- Project metadata (identity, targets) is read via `day metadata --json` instead of parsing
  the manifest in the extension, and the target catalog now comes from the installed CLI (the
  built-in catalog remains only as an offline fallback).

## 0.1.0

Initial standalone release (extracted from the [day](https://github.com/daybrite/day)
repository's `editors/vscode/`, history preserved).

- Day sidebar: project + target tree with per-target run / stop / restart.
- Multi-target launch (tick several targets, run them side by side).
- Mode (debug/release), locale, and dayscript selection.
- `day` task provider and example tasks.
- Project detection via `day.yaml`; `day doctor` integration.
- Falls back to `cargo run -q -p day-cli --` inside a day workspace when no `day` binary is
  on `PATH`.
