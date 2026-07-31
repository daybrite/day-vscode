# day-vscode: Plan for a First-Class Developer Experience

Synthesis of four research tracks (July 2026): a full inventory of this extension and the day
CLI surface; the Dart/Flutter extensions (the category gold standard); ten comparable framework
extensions (React Native Tools, Expo, Tauri, MAUI, NativeScript, Ionic/WebNative, Slint, Qt,
Radon IDE); and the VS Code platform APIs (everything needed is **stable** at `engines ≥ 1.101`).

## Where we stand

The extension today (~1,200 LOC) is an honest Tauri-tier thin wrapper: target tree with
checkboxes, run/build/stop per target via the Tasks API, mode/locale/script pickers, `day
metadata --json` project discovery, a `day` task type, doctor in a terminal. That tier is proven
to earn adoption (Tauri: 500k installs at 518 LOC) — but it leaves Day's two crown jewels
unexploited: **the dayscript engine** (a TCP automation/introspection channel already inside
every running app on all 7 toolkits) and **the 7-toolkit matrix itself** (no other framework can
put AppKit, UIKit, Android, GTK, Qt, XAML, and ArkUI behind one picker).

## Lessons that shape every choice below

1. **Delegate, don't own.** Every extension that shipped its own debug adapter rotted
   (NativeScript died of it; MAUI's closed adapter is its worst-reviewed part). Everything that
   delegated survived (Expo→js-debug, rust-analyzer→CodeLLDB/lldb-dap, Tauri docs→CodeLLDB).
2. **Value lives in the runtime/CLI behind a stable protocol; the editor host stays thin.**
   Flutter's inspector (VM-service extensions + DevTools web app) outlived Flipper's bespoke
   Electron + in-app SDK. Slint compiles preview/design-mode into the LSP server, not the
   extension. Whatever we build must also work from CI and other editors.
3. **The picker must be authoritative.** MAUI's #1 complaint class: device selection ignored.
   With 7 toolkits, the target picker is our identity — it can never silently launch elsewhere.
4. **Partial matrices need loud labels.** MAUI's asymmetric hot-reload matrix generates angrier
   feedback than absence would. Where a Day feature is desktop-only at first, say so in the UI.
5. **Silent failures dominate issue trackers** (RN Tools). Doctor + remediation (MAUI's one
   great feature) and loud "CLI not found / target not buildable here" diagnostics are cheap.
6. **`$rustc` is NOT built into VS Code** — it's contributed by rust-analyzer. Our README
   currently depends on it by accident. Users without rust-analyzer get a non-fatal
   "Invalid problemMatcher reference" and silently lose diagnostics.

---

## Phase 0 — Foundation hardening (days, do immediately)

- **Vendor our problem matchers**: copy rust-analyzer's two-line rustc pattern (MIT/Apache-2.0)
  into `contributes.problemMatchers`/`problemPatterns` as `$day-rustc`, plus `$day-rustc-watch`
  with `background.beginsPattern/endsPattern` keyed to lines the day CLI prints at rebuild
  start/end. Own `owner: "day"` so reruns clear stale diagnostics and we don't fight
  rust-analyzer's. Attach to all provided tasks.
- **Implement `resolveTask`** in the task provider (the fast path for tasks.json /
  `preLaunchTask`); hard rule: reuse the incoming `TaskDefinition` object verbatim.
- **Status-bar cockpit** (Flutter pattern): one item = selected target(s) + running count
  (click → target QuickPick), one item = mode. Selection is authoritative and remembered
  per-project.
- **Distribution hygiene**: esbuild bundling; drop `onStartupFinished` (activation events are
  auto-generated from contributions since 1.74; keep `workspaceContains:**/Day.toml`); declare
  `capabilities.untrustedWorkspaces` + `virtualWorkspaces`; `engines ≥ 1.101`; pre-release
  channel (odd-minor convention).
- **Day.toml schema**: emit a JSON Schema (new `day metadata --schema`), publish to SchemaStore,
  and associate via `contributes.configurationDefaults` →
  `evenBetterToml.schema.associations` (supported cross-extension since 1.63). Recommend (not
  depend on) Even Better TOML.
- **Scaffold distribution**: `day new` writes `.vscode/extensions.json` recommending
  `daybrite.day-vscode` (+ rust-analyzer, Even Better TOML) — the create-tauri-app growth trick.

## Phase 1 — Run, debug, doctor, onboard (the trust core, ~1–2 weeks)

- **Debugging (desktop toolkits first, loudly labeled)**: `contributes.debuggers` type `"day"`
  + `contributes.breakpoints: [{language: "rust"}]` + a DebugConfigurationProvider (Initial +
  Dynamic trigger kinds). `resolveDebugConfiguration` builds via `preLaunchTask` (our background
  matcher makes readiness work) and **rewrites the config type** to an installed Rust debugger,
  probing `llvm-vs-code-extensions.lldb-dap` → `vadimcn.vscode-lldb` → cpptools (rust-analyzer's
  order), with a pin setting. CLI ask: `day build --format json` should emit the artifact
  binary path + launch env per desktop target. Multi-target run = compound configs with one
  shared build. Mobile attach flows come later — label the matrix honestly.
- **Doctor with remediation** (MAUI's best-in-class pattern): CLI ask: `day doctor --format
  json`. Render per-toolkit status in the sidebar tree with fix actions (install links,
  `day doctor --toolkit X` reruns) instead of a wall of terminal text.
- **Getting-started walkthrough** (`contributes.walkthroughs`, `featuredFor: ["**/Day.toml"]`):
  install CLI → doctor per chosen toolkit (`completionEvents: onCommand:`) → scaffold first app
  (`Day: New Project` — multi-step QuickPick over `day new` templates + toolkit multi-select)
  → first launch. Flutter's "Download SDK" flow is the bar for zero-terminal onboarding.
- **Devices & emulators in the tree**: a "Devices" section listing booted iOS simulators,
  Android devices/AVDs, OHOS emulator state, with launch actions (`day ohos emulator launch`
  exists; CLI ask: a unified `day devices --format json` / `day emulator launch <kind>`).
  Newly connected device → offer it (Flutter's `flutterSelectDeviceWhenConnected`).
- **Expose the rest of the CLI**: `Day: Pack` (with format picker), `Day: Lint`,
  `Day: Add Toolkit` (wraps `app add-toolkit`), `Day: Icon` preview/generate.

## Phase 2 — The differentiator: the live app surface (2–4 weeks)

Nobody else can do this across 7 toolkits, and 80% of the plumbing already exists: the
dayscript engine speaks JSON-over-TCP inside every running Day app (tap, input, navigate,
screenshot, ui_idle, assert).

- **Day Inspector panel** (webview): extend the engine protocol with `dump_tree` (piece tree:
  ids, kinds, frames) and `highlight <id>`; the panel shows the live tree of the running app;
  selecting a node highlights it on-device. Add a **live preview pane** fed by the existing
  `screenshot` step (poll on `ui_idle`, ~1–2 fps; `postMessage` with `Uint8Array` → canvas —
  the efficient stable path). Click-preview → hit-test → select node → (later) jump to source.
  Radon IDE charges $21/user/month for this on two platforms; we can ship it open on seven.
  Keep the protocol in the runtime/CLI (Flutter-not-Flipper), the webview dumb.
- **Walkthroughs as tests** (Testing API): a `TestController` mapping `scripts/*.yaml` to test
  items (one child per step). Run profile = `day launch --script` ; CLI ask: per-step NDJSON
  events so steps light up live. Failed screenshot asserts attach images via `TestMessage`;
  a "Continuous Run" profile re-runs the walkthrough on save. Coverage of the piece tree can
  come later via the same NDJSON channel.
- **Save-triggered relaunch**: a `day: watch` background task (rebuild + state-light relaunch on
  save) triggered by the editor but owned by the CLI — hot reload proper is a runtime feature
  (Slint 1.13 / Compose HR precedent) and lands there first; the extension only sends triggers.

## Phase 2.5 — Dayscript debugging: step through a script against the live app

**Shipped foundation (v0.4.1 + CLI):** `day launch --script … --keep-alive` leaves the app
running when the script completes (extension setting `day.script.keepAppRunning`, default on;
per-task `keepAlive` override in tasks.json). Combined with the session registry and
`day drive`, a script author can already run a draft to the end, keep the app open, and probe
the next step interactively. The debugging story builds on exactly this.

1. **`day drive --stdin` (CLI):** an interactive drive mode — one persistent engine
   connection; read a step per line on stdin, emit its JSON result per line on stdout. This is
   the stepping transport (per-step `day drive` invocations reconnect each time; stdin mode
   keeps ordering, latency, and connection state).
2. **A first-party dayscript DAP** (`day script-debug-adapter`, DAP over stdio — the Dart
   "adapter ships in the SDK" pattern; the extension contributes `type: "dayscript"` and a
   `DebugAdapterExecutable` pointing at the CLI):
   - **launch config**: `{type: "dayscript", script: "scripts/walkthrough.yaml", target:
     "macos-appkit"}`; the adapter ensures a live session (launching with `--keep-alive` when
     none exists) and parses the script's `flow:`.
   - **Line mapping**: flow entries are one YAML line each by convention — a line-indexed map
     of steps gives breakpoints, current-line highlighting, and step-over for free (no YAML
     span machinery needed to start).
   - **Stepping semantics**: `stopOnEntry`; *step over* = execute the current step via the
     engine and move the instruction pointer; *continue* = run until a breakpoint, a failing
     step (`ok: false` = a "thrown exception" → stop with the error), or script end — which,
     under keep-alive, leaves the session live rather than tearing the app down.
   - **State panes**: Variables shows the last step's reply (assert results, screenshot path),
     the current route, and the session (target, port); a failing screenshot/assert attaches
     its output. Screenshots open in an editor tab on click.
   - **Debug console = step REPL**: any line typed is parsed as a step (YAML single-key or
     JSON) and executed immediately against the app — this is the interactive script-AUTHORING
     loop; an "append to script" code action turns a successful REPL step into a new flow line.
   - Note on the "no bespoke debug adapter" non-goal: that rule is about RUST debugging
     (delegate to lldb). Dayscript is Day's own language and protocol — a first-party adapter
     in the CLI is the Slint/Dart pattern, and every editor with DAP support inherits it.
3. **Editor affordances on top**: "Debug Script" / "Run Script" CodeLens above `flow:` in
   `scripts/*.yaml`; `contributes.breakpoints` for the script language; gutter run markers;
   "Run to cursor" = continue with a temporary breakpoint.
4. **Later — recording**: the REPL/append loop is half of it; true record-from-UI (user taps
   in the app → steps appear in the script) needs an engine-side event tap
   (`observe_input` protocol addition) — same protocol family as the Phase 2 inspector's
   `dump_tree`/`highlight`.

CLI asks (append to the list): `day drive --stdin`; `day script-debug-adapter` (DAP, stdio);
engine `observe_input` (recording, later).

## Phase 3 — Editor intelligence (no LSP required; incremental forever)

- **Color swatches**: `registerColorProvider` over `Color::rgb/rgba/hex(...)` in Rust files —
  native picker, regenerates the literal. High delight, low cost.
- **Fluent l10n suite**: completions for message keys inside `text("…")`/`tr!` from
  `locales/*.ftl`; document links key → .ftl definition; missing-key diagnostics from
  `day lint --format json`; TextMate injection grammar for placeables in Rust strings.
- **CodeLens**: "▶ Run walkthrough" above `scripts/*.yaml`; "Run on <selected target>" above
  the app entry point; JSON-schema validation for dayscript YAML (`yamlValidation`).
- **Assets**: document links for `resource("name")`; `DocumentDropEditProvider` — drag an asset
  from the Explorer into Rust source to insert the call (stable since 1.70/1.97).
- **Snippets**: piece, page, signal, section/form patterns.
- (Later, optional) Custom text editor for Day.toml as a visual manifest editor —
  `CustomTextEditorProvider` keeps the TOML as the model.

## Phase 4 — Agentic development: the VS Code agent as a first-class Day developer

The benchmark request this phase must satisfy end-to-end, entirely inside VS Code agent mode:

> *"Add a new 'configuration' page to the app and re-launch it on all targets."*

An agent needs the same three things a human Day developer has: **knowledge** (the project's
shape and Day's conventions), **actuation** (build, launch, stop, and *drive* the running app),
and **feedback** (structured diagnostics, runtime state, and pixels). Day is uniquely positioned
on actuation and feedback — the dayscript engine already lives inside every debug launch on all
seven toolkits — so this phase is mostly packaging, not invention.

**Design rule** (from the Flipper/Flutter research): every capability lives in the **CLI** so any
MCP-capable agent (VS Code, Claude Code, Cursor, CI bots) gets it; the extension contributes only
registration and the few tools that need live editor context.

### 4a. Session registry + `day drive` (the enablers, CLI)

- **Session registry**: `day launch` records every session in `build/day/sessions.json` —
  `{target, pid|device, appId, enginePort, engineToken, startedAt}` — and prunes dead entries.
  Today the engine port/token are ephemeral internals of a `--script` run; persisting them is
  THE unlock that lets a later process (an agent tool call) attach to an app the developer
  already has open.
- **Engine always-on in dev launches**: the dayscript engine currently starts only for scripted
  runs. Start it (loopback, token-gated) for every debug-profile launch — or behind
  `day launch --drivable`, default-on from the extension — so "the app that's already running"
  is drivable without a relaunch.
- **`day drive`**: execute dayscript steps against a RUNNING session without a script file:
  `day drive -p macos-appkit --steps-json '[{"navigate":"configuration"},{"ui_idle":null},
  {"screenshot":"config"}]'` → per-step JSON results on stdout (screenshots as file paths +
  base64). Reuses the existing connect/fport machinery; steps are exactly the walkthrough
  vocabulary (`navigate`, `tap`, `input`, `assert_text`, `ui_idle`, `screenshot`, …).
- **`day relaunch`**: stop + rebuild + launch for a set of targets (or `--all-running`), emitting
  NDJSON progress events — the single verb the benchmark request ends with.

### 4b. `day mcp-server` (stdio) — the agent tool surface

Registered by the extension via `lm.registerMcpServerDefinitionProvider` (stable 1.101),
default-on behind `day.mcp.enabled` — the Dart v3.116 rollout pattern. Tool inventory
(all thin wrappers over the CLI/registry above; results are structured JSON, screenshots are
MCP image content so vision models can *look at the app*):

| Tool | Does | Returns |
|---|---|---|
| `day_metadata` | project identity, declared targets, host-buildable set, locales | JSON |
| `day_doctor` | per-toolkit environment status | JSON findings |
| `day_build` | build target(s) | structured rustc diagnostics (message-format=json) |
| `day_launch` / `day_relaunch` / `day_stop` | lifecycle for target set / all running | per-target ok/err + session entries |
| `day_running` | list live sessions | registry contents |
| `day_drive` | run dayscript steps against a live session | per-step results + **images** |
| `day_screenshot` | capture a live session's screen | **image** |
| `day_lint` | fluent coverage / id checks | structured findings |
| `day_devices` | list + boot emulators/simulators | JSON |
| `day_ui_tree` *(Phase 2 dependency)* | dump the live piece tree (ids, kinds, frames) | JSON — lets non-vision agents "see" structure |

MCP **prompts/resources** ship Day's conventions from the CLI's embedded docs: an `add-page`
prompt (the recipe below), `day://docs/navigation`, `day://docs/localization`, the piece
catalog. The agent asks for the recipe instead of hallucinating project structure.

### 4c. Knowledge: conventions the agent can read

- **`day new` scaffolds `AGENTS.md`** (next to the existing `.vscode/extensions.json` move):
  the project map (pages live in `src/pages/`, nav registration site, fluent keys must exist in
  every `locales/*/app.ftl`, every interactive piece gets a stable `.id()`, walkthrough steps in
  `scripts/walkthrough.yaml`) plus the "add a page" checklist. VS Code agent mode reads
  `AGENTS.md` automatically; so do Claude Code and friends — one artifact serves all agents.
- The extension contributes the same recipe via `contributes.chatInstructions` for Day
  workspaces that predate the scaffold.

### 4d. Editor-context LM tools (extension, small by design)

Only where editor state matters, via `contributes.languageModelTools` (+`prepareInvocation`
confirmation): `#day_run_selected` (the cockpit's current target/mode/locale selection),
`#day_selected_targets` (read it). Everything else belongs to MCP. A `@day` chat participant
stays out until a branded Q&A surface earns its keep.

### 4e. The benchmark request, traced

1. Agent reads `AGENTS.md` (or pulls the MCP `add-page` prompt) → knows the page recipe.
2. `day_metadata` → target list (`macos-appkit`, `ios-uikit`, …), locale list (`en fr ar zh-CN`).
3. Agent edits with its own file tools: `src/pages/configuration.rs`, nav registration,
   `nav-configuration` fluent keys in all four locales, stable `.id()`s, a walkthrough step.
4. `day_relaunch {targets: "all"}` → structured diagnostics if the build breaks → agent fixes →
   repeat. (Problem-matcher squiggles from Phase 0 give the same signal on task-driven paths.)
5. `day_drive {target: …, steps: [navigate: configuration, ui_idle, screenshot]}` per target →
   the agent *sees* the new page on every toolkit (or asserts ids, vision-free) and reports
   with evidence.
6. Optional: `day_lint` proves fluent coverage; the Testing-API walkthrough profile (Phase 2)
   gives the same loop a first-class UI for humans.

Human-in-the-loop: MCP's built-in tool-confirmation UI covers launch/stop; `day_drive` against
an app the developer is interacting with is the one to keep confirmable by default.

### 4f. Marketplace polish

README GIFs of the 7-target cockpit + agent loop, walkthrough contribution, sponsor link,
l10n via `vscode.l10n`.

## CLI co-evolution asks (ordered)

1. `day doctor --format json`
2. Artifact path + launch env in `day build --format json` (per desktop target)
3. Per-step NDJSON events during `day launch --script`
4. `day devices --format json` + unified `day emulator launch <android|ohos> [--name]`
5. ~~`day metadata --schema`~~ ✅ shipped (served at daybrite.dev/schema/day.toml.json)
6. dayscript engine: `dump_tree`, `highlight` commands
7. `day new --list-templates --format json`; ~~`.vscode/extensions.json` in scaffolds~~ ✅ shipped
8. Rebuild start/end marker lines (stable, documented) for the watch matcher
9. **Session registry** (`build/day/sessions.json`: target, pid, engine port+token) — the
   attach-to-running-app unlock for agents and the inspector alike
10. **Engine always-on** for debug launches (loopback, token-gated) or `--drivable`
11. **`day drive`** (steps-JSON in, per-step JSON out, screenshots as path+base64)
12. **`day relaunch`** (stop + rebuild + launch a target set / `--all-running`, NDJSON events)
13. **`day mcp-server`** (stdio; the 4b tool table; MCP image content for screenshots;
    prompts/resources from embedded docs)
14. **`AGENTS.md` in `day new` scaffolds** (project map + add-a-page recipe)

## Explicit non-goals (learned from the graveyard)

- No bespoke debug adapter, ever (NativeScript). No duplicating rust-analyzer, Even Better
  TOML, or Dependi (manifest/deps tooling). No bundling the day CLI inside the VSIX. No
  closed-source components (Radon's ceiling; C# Dev Kit's backlash). No webview UI that can't
  degrade to a command/terminal path. No feature shipped without its "not supported on X"
  label.
