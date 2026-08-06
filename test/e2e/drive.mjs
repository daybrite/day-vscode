// Tier 2: drive the installed extension through a real session and photograph it.
//
//     node test/e2e/drive.mjs [--out DIR] [--no-run]
//
// The run ends with a set of PNGs under `--out` (default build/screenshots/<combo>/), named for
// what they show, and a manifest.json describing them. They are evidence for CI and the source of
// the extension's README and Marketplace images, which is why the harness fixes the theme, the
// window size, and the fixture: the same command on the same VS Code build should produce the
// same picture.
//
// `--no-run` stops after the UI captures and skips building the app, which takes minutes.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureParent, hostCombo, scaffold } from "./fixture.mjs";
import {
  captureDesktop,
  installVsix,
  launchVSCode,
  resolveVSCode,
  shortTmp,
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

/** Save a screenshot of the VS Code window under a stable, descriptive name. */
async function shot(win, name, caption) {
  const file = join(OUT, `${COMBO}-${name}.png`);
  await win.screenshot({ path: file });
  shots.push({ file, caption, kind: "window" });
  console.log(`  · ${name} — ${caption}`);
}

/** Save a whole-desktop capture, which is the only way to get the app's own window in frame. */
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
  const box = row(win, combo).locator('[role="checkbox"]').first();
  await box.click();
  await win.waitForTimeout(500);
  const checked = await box.getAttribute("aria-checked");
  if (checked !== "true") {
    throw new Error(`${combo} did not tick (aria-checked=${checked})`);
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
const exe = await resolveVSCode();
console.log(`VS Code ${VSCODE_VERSION}: ${exe}`);

const work = shortTmp("day-vsc-e2e");
const extensionsDir = join(work, "e");
const userDataDir = join(work, "u");
mkdirSync(extensionsDir, { recursive: true });
console.log(installVsix(exe, VSIX, extensionsDir, userDataDir));

const workspace = scaffold({ dayBin: DAY_BIN, parent: fixtureParent(work) });
console.log(`fixture: ${workspace}`);

const openFiles = [join(workspace, "src", "pages", "home.rs")].filter((f) => existsSync(f));
const { app, win } = await launchVSCode({ exe, workspace, extensionsDir, userDataDir, openFiles });

try {
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
  await shot(win, "01-cockpit", "The Day view: project, build mode, and every target in Day.toml");

  // ── The command surface ────────────────────────────────────────────────────────────────────
  await win.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  await win.waitForSelector(".quick-input-widget", { state: "visible" });
  await win.keyboard.type("Day: ", { delay: 12 });
  await win.waitForTimeout(900);
  await shot(win, "02-commands", "Every Day command in the palette");
  await win.keyboard.press("Escape");

  // ── Target selection ───────────────────────────────────────────────────────────────────────
  await command(win, "Day: Select Targets");
  await win.waitForTimeout(1200);
  await shot(win, "03-select-targets", "Picking which targets Run and Build act on");
  await win.keyboard.press("Escape");

  // ── Settings ───────────────────────────────────────────────────────────────────────────────
  await command(win, "Day: Open Settings");
  await win.waitForTimeout(1800);
  await shot(win, "04-settings", "The extension's settings, from CLI path to agent access");
  await command(win, "View: Close All Editors");

  // ── Toolchain check ────────────────────────────────────────────────────────────────────────
  await command(win, "Day: Doctor (check toolchains)");
  await win.waitForTimeout(12_000);
  await shot(win, "05-doctor", `day doctor reporting this host's toolchains (${process.platform})`);

  if (RUN_APP) {
    // ── Build and run the host's own combo, through the extension ────────────────────────────
    await command(win, "Day: Focus on Build & Run View");
    await tickTarget(win, COMBO);
    await shot(win, "06-target-ticked", `${COMBO} ticked for Run`);

    await command(win, "Day: Run Selected Targets");
    console.log(`  building ${COMBO} (timeout ${Math.round(BUILD_TIMEOUT_MS / 60000)}m)…`);

    // "It is running" is a question the extension already answers: a running target's row swaps
    // its inline Run action for Stop and Restart (contextValue dayTargetRunning). Watch for that
    // rather than for words in the terminal, which depend on the panel being visible, on the
    // scrollback, and on the CLI's wording.
    const stopAction = row(win, COMBO).locator('a[aria-label="Stop"]');
    let built = false;
    let shotBuilding = false;
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await stopAction.count()) > 0) {
        built = true;
        break;
      }
      const text = await terminalText(win);
      if (!shotBuilding && /Building|Compiling/.test(text)) {
        shotBuilding = true;
        await shot(win, "07-building", "A build running as a VS Code task, with live diagnostics");
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
    await shot(win, "08-running", `${COMBO} running: the cockpit tracks the live process`);
    desktopShot("09-app", `The Day app running beside the editor that launched it (${COMBO})`);

    await command(win, "Day: Stop All");
    await win.waitForTimeout(2500);
    await shot(win, "10-stopped", "Back to idle after Stop All");
  }
} finally {
  writeFileSync(
    join(OUT, "manifest.json"),
    `${JSON.stringify(
      { combo: COMBO, platform: process.platform, vscode: VSCODE_VERSION, shots },
      null,
      2,
    )}\n`,
  );
  await app.close().catch(() => {});
}

console.log(`${shots.length} screenshot(s) → ${OUT} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
