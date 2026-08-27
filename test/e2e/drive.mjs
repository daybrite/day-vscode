// Tier 2: drive the installed extension through a real session and photograph it.
//
//     node test/e2e/drive.mjs [--out DIR] [--no-run]
//
// The run ends with a set of PNGs under `--out` (default build/screenshots/<combo>/), named for
// what they show, and a manifest.json describing them. It opens with the getting-started story —
// the walkthrough, then the New Project wizard driven end to end until a scaffolded app appears
// in the Day view beside the fixture — and then photographs the cockpit, a build, and the app. They are evidence for CI and the source of
// the extension's README and Marketplace images, which is why the harness fixes the themes, the
// window size, and the fixture: the same command on the same VS Code build should produce the
// same picture.
//
// Every editor surface is photographed twice, `<combo>-NN-name-dark.png` and `-light.png`, so the
// website can show whichever matches the reader's own colour scheme. See `shot`.
//
// `--no-run` stops after the UI captures and skips building the app, which takes minutes.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureParent, hostCombo, scaffold } from "./fixture.mjs";
import {
  captureDesktop,
  installVsix,
  launchVSCode,
  resolveVSCode,
  shortTmp,
  THEMES,
  VSCODE_VERSION,
} from "./vscode.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const COMBO = hostCombo();
const OUT = resolve(flag("--out", join(root, "build", "screenshots", COMBO)));
const VSIX = resolve(flag("--vsix", join(root, "day-vscode.vsix")));
const RUN_APP = !args.includes("--no-run");
const DAY_BIN = process.env.DAY_BIN || "day";
/** A cargo build from a cold registry is minutes, not seconds. */
const BUILD_TIMEOUT_MS = Number(process.env.DAY_E2E_BUILD_TIMEOUT_MS || 20 * 60 * 1000);

mkdirSync(OUT, { recursive: true });
const shots = [];
/** Assigned once VS Code is up; see `shot`. */
let setTheme;

// ── Phase tracking + watchdog ────────────────────────────────────────────────────────────────
// A hung UI run is otherwise invisible: GitHub shows a step "in progress" for six hours and the
// logs only arrive once the job is killed, by which point nobody can tell which call stopped
// answering. Every phase announces itself with an elapsed time, and a timer force-exits the run
// with the current phase named — a failing run that says where it stopped beats a silent one.
const started = Date.now();
let phase = "startup";
const since = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
function enter(name) {
  phase = name;
  console.log(`[${since()}] ${name}`);
}
const WATCHDOG_MS = Number(process.env.DAY_E2E_WATCHDOG_MS || 45 * 60 * 1000);
const watchdog = setTimeout(() => {
  console.error(
    `\n✗ watchdog: still in "${phase}" after ${since()}. Nothing in this harness should take ` +
      `that long, so something external stopped answering. Screenshots so far: ${shots.length}.`,
  );
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

/**
 * Save a screenshot of the VS Code window under a stable, descriptive name — once per theme.
 *
 * The site swaps captures with the reader's own light/dark preference, so each surface is
 * photographed in both without being set up twice: the theme changes underneath a screen that is
 * already in the state the caption describes. Whatever ran to reach that state ran once.
 *
 * The session is left in the first theme, so anything that reads the screen afterwards sees the
 * same colours it would have without this.
 */
async function shot(win, name, caption) {
  const themes = {};
  for (const theme of THEMES) {
    if (!(await setTheme(theme))) continue;
    const file = join(OUT, `${COMBO}-${name}-${theme.id}.png`);
    await win.screenshot({ path: file });
    themes[theme.id] = file;
  }
  const taken = Object.keys(themes);
  if (!taken.length) throw new Error(`no theme could be applied for ${name}`);
  if (taken.length > 1) await setTheme(THEMES[0]);
  shots.push({ file: themes[taken[0]], caption, kind: "window", themes });
  console.log(`  · ${name} — ${caption} (${taken.join(", ")})`);
}

/**
 * Save a whole-desktop capture, which is the only way to get the app's own window in frame.
 *
 * One theme only, unlike `shot`. The frame holds a native Day app whose appearance follows the
 * OS, not VS Code's setting, so restyling the editor alone would photograph a light editor beside
 * a dark app — a pairing no reader's machine would ever produce.
 */
function desktopShot(name, caption) {
  const file = join(OUT, `${COMBO}-${name}.png`);
  if (captureDesktop(file)) {
    shots.push({ file, caption, kind: "desktop" });
    console.log(`  · ${name} — ${caption} (desktop)`);
  }
}

/**
 * Run a command through the palette, verifying the match before committing to it.
 *
 * The palette is a fuzzy matcher: typing "Preferences: Open Settings" happily lands on
 * "Preferences: Open Accessibility Settings", and the run continues against the wrong screen. So
 * read the focused row back and refuse anything but an exact title.
 */
async function command(win, title) {
  // Opening the palette is itself flaky: a keystroke sent while focus sits in an editor's find
  // box or a webview can be swallowed, and the run then fails somewhere later against the wrong
  // screen. Click the workbench to ground focus, and retry the shortcut before giving up.
  const chord = process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P";
  const widget = win.locator(".quick-input-widget");
  for (let attempt = 1; ; attempt++) {
    await win.keyboard.press("Escape");
    await win.locator(".monaco-workbench").click({ position: { x: 5, y: 5 }, force: true });
    await win.keyboard.press(chord);
    try {
      await widget.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await win.waitForTimeout(1000);
    }
  }
  await win.keyboard.type(title, { delay: 8 });
  await win.waitForTimeout(700);
  const rows = win.locator(".quick-input-list .monaco-list-row");
  const count = await rows.count();
  const labels = [];
  for (let i = 0; i < Math.min(count, 10); i++) {
    labels.push((await rows.nth(i).innerText()).replace(/\s+/g, " ").trim());
  }
  const wanted = title.replace(/\s+/g, " ").trim().toLowerCase();
  const hit = labels.findIndex((l) => l.toLowerCase().startsWith(wanted));
  if (hit < 0) {
    throw new Error(`palette has no match for "${title}"; offered: ${JSON.stringify(labels)}`);
  }
  for (let i = 0; i < hit; i++) await win.keyboard.press("ArrowDown");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(900);
}

/**
 * Open `<project>`'s `file` in the editor, through Quick Open.
 *
 * Quick Open indexes a file by its path RELATIVE TO ITS WORKSPACE FOLDER, so the folder's own name
 * is not part of the query — searching "hello-day/src/lib.rs" finds nothing at all. With two
 * projects in the window both offer a `lib.rs`, so the query is the file name and the right row is
 * found by reading the descriptions back, the same way `command` checks the palette.
 *
 * Retried because a folder added to the workspace a moment ago is not in the file index yet, and
 * the first attempt legitimately finds nothing.
 */
async function openFile(win, project, file) {
  const chord = process.platform === "darwin" ? "Meta+P" : "Control+P";
  for (let attempt = 1; ; attempt++) {
    await win.keyboard.press("Escape");
    await win.locator(".monaco-workbench").click({ position: { x: 5, y: 5 }, force: true });
    await win.keyboard.press(chord);
    await win.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 10_000 });
    await win.keyboard.type(file, { delay: 10 });
    await win.waitForTimeout(900);
    const rows = win.locator(".quick-input-list .monaco-list-row");
    const count = Math.min(await rows.count(), 12);
    const labels = [];
    for (let i = 0; i < count; i++) {
      labels.push((await rows.nth(i).innerText()).replace(/\s+/g, " ").trim());
    }
    const hit = labels.findIndex((l) => l.toLowerCase().includes(project.toLowerCase()));
    if (hit >= 0) {
      for (let i = 0; i < hit; i++) await win.keyboard.press("ArrowDown");
      await win.keyboard.press("Enter");
      await win.waitForTimeout(900);
      return;
    }
    if (attempt >= 5) {
      throw new Error(
        `quick open has no ${file} under ${project}; offered: ${JSON.stringify(labels)}`,
      );
    }
    await win.keyboard.press("Escape");
    await win.waitForTimeout(2000); // the new folder is still being indexed
  }
}

/**
 * Wait for a quick input showing `title`, so a step cannot photograph the previous screen.
 *
 * The wizard's steps all render into the SAME `.quick-input-widget`, and they arrive one frame
 * apart — without reading the title back, a capture races the transition and lands on whichever
 * question was up a moment ago, which is invisible in a green run and wrong in the docs.
 */
async function quickInput(win, title, timeout = 15_000) {
  const widget = win.locator(".quick-input-widget");
  await widget.waitFor({ state: "visible", timeout });
  await win
    .locator(".quick-input-titlebar", { hasText: title })
    .first()
    .waitFor({ state: "visible", timeout });
  await win.waitForTimeout(350); // let the list settle before the shutter
  return widget;
}

/** The tree row whose label starts with `label` (targets carry a description after the name). */
function row(win, label) {
  return win.locator(`.pane-body [role="treeitem"]`).filter({ hasText: label }).first();
}

/**
 * Tick a target and prove the tick took.
 *
 * The row's checkbox is its own element (`[role="checkbox"]` inside the tree item), not something
 * a Space keypress on the row toggles — pressing Space merely selects, and Run then finds no
 * selection and quietly does nothing. Reading `aria-checked` back turns that silence into a
 * failure at the step that caused it.
 */
async function tickTarget(win, combo) {
  // Whatever was clicked before this may still be showing its hover over the tree.
  await dismissHover(win);
  const box = row(win, combo).locator('[role="checkbox"]').first();
  // Retried, with a SHORT first attempt. What blocks the click is an overlay, and Playwright's own
  // retrying does not help against one: it re-attempts into the same obstruction until the full
  // timeout expires. The windows-xaml leg spent thirty seconds being told
  // `<p>D:\…\day-fixture</p> from <div class="context-view …"> intercepts pointer events` — the
  // hover for the project row clicked a moment earlier. Moving the pointer away closes it, so a
  // failed attempt is worth a second look rather than a longer wait.
  for (let attempt = 1; ; attempt++) {
    try {
      await box.click({ timeout: attempt === 1 ? 8000 : 30_000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await dismissHover(win);
      await win.keyboard.press("Escape");
    }
  }
  await win.waitForTimeout(500);
  const checked = await box.getAttribute("aria-checked");
  if (checked !== "true") {
    throw new Error(`${combo} did not tick (aria-checked=${checked})`);
  }
}

/**
 * Park the pointer somewhere harmless and wait for any hover it leaves behind to close.
 *
 * Clicking a tree row leaves the cursor ON it, and VS Code then opens that row's hover — for a
 * project row, its full path — as a `.context-view` overlay drawn OVER the rows beneath. The next
 * click lands on the tooltip instead of the checkbox, which Playwright reports as an interception
 * and retries until it times out thirty seconds later.
 */
async function dismissHover(win) {
  await win.mouse.move(2, 2);
  const overlay = win.locator(".context-view").first();
  // Waiting for it to go beats a fixed sleep: the hover closes on pointer-leave, and how long
  // that takes is the animation's business, not ours.
  await overlay.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await win.waitForTimeout(150);
}

/**
 * Make `name` the focused project by clicking its row, and prove it took.
 *
 * Focus follows the active editor, so opening a file from one project moves it — which is right
 * for a person and wrong for a script that is about to build a different one.
 */
async function focusProject(win, name) {
  await row(win, name).click();
  await win.waitForTimeout(600);
  await dismissHover(win);
  const focused = (await treeText(win)).find((t) => t.includes("focused"));
  if (!focused?.startsWith(name)) {
    throw new Error(`clicking ${name} left the focus on ${JSON.stringify(focused)}`);
  }
}

/** Read the Day view's rows as plain text — the assertable form of the screenshot. */
async function treeText(win) {
  const items = await win.locator(`.pane-body [role="treeitem"]`).allInnerTexts();
  return items.map((t) => t.replace(/\s+/g, " ").trim());
}

/**
 * Everything the integrated terminals currently show, for progress polling and for quoting back in
 * a failure.
 *
 * `textContent` through `evaluateAll`, not `innerText`: innerText is a rendered-layout property
 * and comes back empty for a panel that is not visible, which is most of the time while the Day
 * view has focus. Reading text at all depends on xterm's DOM renderer, which is why the harness
 * turns terminal GPU acceleration off — a canvas terminal has no text in the DOM to read.
 */
async function terminalText(win) {
  const rows = win.locator(".xterm-rows");
  if ((await rows.count()) === 0) return "";
  const chunks = await rows.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  return chunks.join("\n").replace(/\u00a0/g, " ");
}

const t0 = Date.now();
enter("resolving VS Code");
const exe = await resolveVSCode();
console.log(`VS Code ${VSCODE_VERSION}: ${exe}`);

const work = shortTmp("day-vsc-e2e");
const extensionsDir = join(work, "e");
const userDataDir = join(work, "u");
mkdirSync(extensionsDir, { recursive: true });
enter("installing the .vsix");
console.log(installVsix(exe, VSIX, extensionsDir, userDataDir));

enter("scaffolding the fixture");
const workspace = scaffold({ dayBin: DAY_BIN, parent: fixtureParent(work) });
console.log(`fixture: ${workspace}`);

const openFiles = [join(workspace, "src", "pages", "home.rs")].filter((f) => existsSync(f));
enter("launching VS Code");
const session = await launchVSCode({ exe, workspace, extensionsDir, userDataDir, openFiles });
const { app, win } = session;
setTheme = session.setTheme;

try {
  enter("capturing the welcome page");
  // ── Getting started ────────────────────────────────────────────────────────────────────────
  // What someone sees before they have anything: the walkthrough, then the New Project flow that
  // its first button starts. Photographed on every host because the answer differs — the target
  // list offers what THAT machine can build.
  await command(win, "Day: Get Started with Day");
  await win
    .locator(".gettingStartedContainer, .welcomePageContainer")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await win.waitForTimeout(800);
  await shot(win, "01-welcome", "The walkthrough VS Code shows before there is a Day project");

  // The wizard's steps are photographed over whatever is behind them, and VS Code's own Welcome
  // tab puts a "Recent" list of temporary fixture paths in frame. The Day view is both tidier and
  // the truer context for a picture of the Day wizard.
  await command(win, "View: Close All Editors");
  await command(win, "Day: Focus on Build & Run View");
  await win.waitForTimeout(500);

  enter("driving the New Project wizard");
  const newProjectName = "hello-day";
  // A leftover from a previous run makes `day new` refuse with `"hello-day" already exists`, and
  // the wizard then hangs waiting for a project that will never appear. The fixture parent is
  // deliberately stable — CI keys a cache to it and a local run reuses the build — so the
  // scaffold target has to be cleared, exactly as `scaffold()` clears the fixture's own.
  rmSync(join(fixtureParent(work), newProjectName), { recursive: true, force: true });
  await command(win, "Day: New Project"); // typed without the ellipsis; the match is a prefix

  await quickInput(win, "what to create");
  await shot(win, "02-new-kind", "New Project: an app, a piece, or a part");
  await win.keyboard.press("Enter"); // App, the first row

  await quickInput(win, "Project name");
  await win.keyboard.type(newProjectName, { delay: 20 });
  await win.waitForTimeout(400);
  await shot(win, "03-new-name", "Naming the app, validated as you type");
  await win.keyboard.press("Enter");

  // Blank accepts the CLI's own default (`dev.example.<name>`), which is what the placeholder
  // says — so this step is one keypress and needs no picture of its own.
  await quickInput(win, "Application id");
  await win.keyboard.press("Enter");

  await quickInput(win, "Platform-toolkits");
  await shot(
    win,
    "04-new-targets",
    `Choosing the platforms to ship on — ${COMBO} is preselected as this host's own`,
  );
  await win.keyboard.press("Enter"); // the host default arrives ticked

  await quickInput(win, "Window title");
  await win.keyboard.press("Enter");

  // The parent folder. An OS dialog here would be undrivable; `files.simpleDialog.enable` makes
  // it a quick input, so the path can simply be typed.
  const parent = fixtureParent(work);
  await quickInput(win, "parent folder", 30_000);
  await win.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await win.keyboard.type(parent.endsWith(sep) ? parent : parent + sep, { delay: 8 });
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");

  enter("waiting for the scaffold");
  // `day new` fetches nothing, but it writes a whole tree and then cargo metadata runs over it.
  await win.waitForFunction(
    (name) =>
      [...document.querySelectorAll('.pane-body [role="treeitem"]')].some((el) =>
        (el.textContent ?? "").includes(name),
      ),
    newProjectName,
    { timeout: 180_000 },
  );
  // Open something from the app that was just made. Every capture from here on frames the editor,
  // and an empty editor area photographs as VS Code's watermark — which says nothing about Day and
  // takes up most of the picture. `View: Close All Editors` above cleared the fixture's own file
  // to keep the wizard's backdrop tidy, so this is also what puts an editor back.
  await openFile(win, newProjectName, "lib.rs");
  await command(win, "Day: Focus on Build & Run View");
  await win.waitForTimeout(800);
  await shot(
    win,
    "05-new-created",
    "The scaffolded app open in the editor, listed in the Day view beside the one already there",
  );

  // The scaffolded app JOINS the workspace, and opening its `lib.rs` made it the focused project
  // — focus follows the active editor. Everything below builds and runs, and it has to be the
  // FIXTURE: that is the project the job's Rust cache is keyed to, so building the new one instead
  // would be a cold compile of a different app on every run. Hand focus back explicitly, and prove
  // it, rather than relying on which editor happened to be active.
  const fixtureName = workspace.split(/[\\/]/).filter(Boolean).pop();
  await focusProject(win, fixtureName);

  enter("capturing the UI surfaces");
  // ── The cockpit ────────────────────────────────────────────────────────────────────────────
  await command(win, "Day: Focus on Build & Run View");
  await win.waitForFunction(
    () => document.querySelectorAll('.pane-body [role="treeitem"]').length > 3,
    undefined,
    { timeout: 60_000 },
  );
  const tree = await treeText(win);
  console.log(`  tree: ${JSON.stringify(tree)}`);
  if (!tree.some((t) => t.startsWith(COMBO))) {
    throw new Error(`the cockpit does not list ${COMBO}: ${JSON.stringify(tree)}`);
  }
  await shot(win, "06-cockpit", "The Day view: project, build mode, and every target in Day.toml");

  // ── The command surface ────────────────────────────────────────────────────────────────────
  await win.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  await win.waitForSelector(".quick-input-widget", { state: "visible" });
  await win.keyboard.type("Day: ", { delay: 12 });
  await win.waitForTimeout(900);
  await shot(win, "07-commands", "Every Day command in the palette");
  await win.keyboard.press("Escape");

  // ── Target selection ───────────────────────────────────────────────────────────────────────
  await command(win, "Day: Select Targets");
  await win.waitForTimeout(1200);
  await shot(win, "08-select-targets", "Picking which targets Run and Build act on");
  await win.keyboard.press("Escape");

  // ── Settings ───────────────────────────────────────────────────────────────────────────────
  await command(win, "Day: Open Settings");
  await win.waitForTimeout(1800);
  await shot(win, "09-settings", "The extension's settings, from CLI path to agent access");
  await command(win, "View: Close All Editors");

  // ── Toolchain check ────────────────────────────────────────────────────────────────────────
  await command(win, "Day: Doctor (check toolchains)");
  await win.waitForTimeout(12_000);
  await shot(win, "10-doctor", `day doctor reporting this host's toolchains (${process.platform})`);

  if (RUN_APP) {
    // ── Build and run the host's own combo, through the extension ────────────────────────────
    await command(win, "Day: Focus on Build & Run View");
    // Re-assert focus HERE, not once after scaffolding: it drifts. Focus follows the active
    // editor, and `View: Close All Editors` above makes the scaffolded app's `lib.rs` active on
    // its way out — which quietly hands the cockpit to `hello-day`. Run then acts on that project,
    // whose targets nobody ticked, and does nothing at all.
    await focusProject(win, fixtureName);
    await tickTarget(win, COMBO);
    await shot(win, "11-target-ticked", `${COMBO} ticked for Run`);

    enter(`building and running ${COMBO} (build timeout ${Math.round(BUILD_TIMEOUT_MS / 60000)}m)`);
    await command(win, "Day: Run Selected Targets");

    // "It is running" is a question the extension already answers: a running target's row swaps
    // its inline Run action for Stop and Restart (contextValue dayTargetRunning). Watch for that
    // rather than for words in the terminal, which depend on the panel being visible, on the
    // scrollback, and on the CLI's wording.
    const stopAction = row(win, COMBO).locator('a[aria-label="Stop"]');
    let built = false;
    let shotBuilding = false;
    // Two budgets. The long one is how long a BUILD may take; the short one is how long it may
    // take to START, and it exists because the failure mode that cost half an hour was a run that
    // never began — `Run Selected Targets` acting on a project with nothing ticked reports that in
    // a toast and returns. Silence is the symptom, so silence gets its own, much shorter, clock.
    //
    // Keyed on the SAME signal the loop already exits by, which is why a slow build cannot trip
    // it: the runner registers a target as running the moment `executeTask` returns (runner.ts),
    // long before anything compiles, and the row's Stop action appears with it. Still being here
    // after the short budget therefore means no task was ever started. Terminal text is NOT a
    // usable signal for this — a local run built and launched without ever matching
    // /Building|Compiling/ in the DOM.
    const STARTED_MS = 180_000;
    const startedBy = Date.now() + STARTED_MS;
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await stopAction.count()) > 0) {
        built = true;
        break;
      }
      const text = await terminalText(win);
      if (!shotBuilding && /Building|Compiling/.test(text)) {
        shotBuilding = true;
        await shot(win, "12-building", "A build running as a VS Code task, with live diagnostics");
      }
      if (Date.now() > startedBy) {
        throw new Error(
          `${COMBO} never entered the running state within ${STARTED_MS / 1000}s, so the run did ` +
            `not start. Most likely the ticked target and the FOCUSED project are different ` +
            `projects — Run acts on the focused one. The cockpit reads:\n  ` +
            `${(await treeText(win)).join("\n  ")}\nTerminal tail:\n${text.slice(-1200)}`,
        );
      }
      if (/^\s*error(\[|:)/m.test(text)) {
        throw new Error(`the build reported an error:\n${text.slice(-4000)}`);
      }
      await win.waitForTimeout(5000);
    }
    if (!built) {
      const tail = (await terminalText(win)).slice(-4000);
      throw new Error(`${COMBO} never reached the running state within ${BUILD_TIMEOUT_MS}ms:\n${tail}`);
    }

    // The app is a separate native window, so the editor screenshot cannot show it.
    await win.waitForTimeout(12_000);
    await shot(win, "13-running", `${COMBO} running: the cockpit tracks the live process`);
    enter("capturing the desktop");
    desktopShot("14-app", `The Day app running beside the editor that launched it (${COMBO})`);

    await command(win, "Day: Stop All");
    await win.waitForTimeout(2500);
    await shot(win, "15-stopped", "Back to idle after Stop All");
  }
} finally {
  enter("writing the manifest and closing");
  clearTimeout(watchdog);
  writeFileSync(
    join(OUT, "manifest.json"),
    `${JSON.stringify(
      { combo: COMBO, platform: process.platform, vscode: VSCODE_VERSION, shots },
      null,
      2,
    )}\n`,
  );
  // Bounded like everything else: Electron shutdown is the one remaining call that could sit
  // there forever, and the run's results are already on disk by this point. The loser of the race
  // is cleared rather than left pending — an unref'd timer would not hold the loop, but this one
  // is not unref'd, so a fast close still cost 30 seconds of "finished but not exited".
  let bail;
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((r) => {
      bail = setTimeout(r, 30_000);
    }),
  ]);
  clearTimeout(bail);
}

console.log(`${shots.length} screenshot(s) → ${OUT} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
// Explicit, because "the script finished" and "the process exited" have come apart here before:
// everything this run produces is already on disk, and a stray handle — an Electron child that
// outlived `close`, a socket Playwright kept — would otherwise leave the process alive with
// nothing left to do. Anything that still needs to run belongs above this line.
process.exit(0);
