// Scaffold the workspace the extension is exercised against.
//
// A real `day new app` project rather than a checked-in fixture: the extension's whole job is to
// read what the CLI reports, so a hand-written Day.toml would test the extension against a shape
// no user has. It also means the fixture tracks the CLI — a new target or a renamed field shows up
// here the same day it ships.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every target the cockpit should list. The host's own combo is what gets built and run; the
 * others are there because a cockpit showing one target is a poor screenshot and a poor test —
 * the tree greys out what this host cannot build, and that logic deserves to be on screen.
 */
export const FIXTURE_TARGETS = [
  "macos-appkit",
  "windows-xaml",
  "linux-gtk",
  "ios-uikit",
  "android-mdc",
  "web-dom",
];

/**
 * Where the scaffold goes. CI points this INSIDE the workspace so `Swatinem/rust-cache` can find
 * the fixture's `target/` and skip recompiling the Day framework on every run; locally a temp
 * directory keeps the checkout clean. Only the VS Code user-data-dir has to stay short.
 */
export function fixtureParent(fallback) {
  return process.env.DAY_E2E_FIXTURE_PARENT || fallback;
}

/** The combo this host builds and runs, matching the day repo's own per-combo CI legs. */
export function hostCombo() {
  if (process.env.DAY_E2E_COMBO) return process.env.DAY_E2E_COMBO;
  if (process.platform === "darwin") return "macos-appkit";
  if (process.platform === "win32") return "windows-xaml";
  return "linux-gtk";
}

/**
 * Create `<parent>/<name>` with `day new app`, point the extension at this run's CLI, and return
 * the project path. Removes any previous copy so a rerun starts from the same state.
 */
export function scaffold({ dayBin, parent, name = "day-fixture", targets = FIXTURE_TARGETS }) {
  const dir = join(parent, name);
  // Reuse a project that is already there. `day new app` is deterministic, so re-running it buys
  // nothing — and it would delete `build/day/cargo/`, which is exactly what CI's cache restores
  // into this directory and what keeps a run from recompiling the whole framework. DAY_E2E_FRESH=1
  // forces the scaffold when the CLI's output itself is what changed.
  const reusable = existsSync(join(dir, "Day.toml")) && process.env.DAY_E2E_FRESH !== "1";
  if (!reusable) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(parent, { recursive: true });
    const res = spawnSync(
      dayBin,
      ["new", "app", name, "--toolkit", targets.join(","), "--no-input"],
      { cwd: parent, encoding: "utf8", stdio: "pipe", timeout: 300_000, killSignal: "SIGKILL" },
    );
    if (res.status !== 0 || !existsSync(join(dir, "Day.toml"))) {
      throw new Error(
        `day new app failed (exit ${res.status}):\n${res.stdout ?? ""}${res.stderr ?? ""}`,
      );
    }
  }

  // The extension resolves `day` from PATH by default; CI's binary is an absolute path in the
  // runner temp dir, so the workspace names it explicitly. This is also the setting a user edits,
  // so exercising it is not a detour.
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  writeFileSync(
    join(dir, ".vscode", "settings.json"),
    `${JSON.stringify({ "day.cliPath": dayBin }, null, 2)}\n`,
  );
  // `day new` leaves extension recommendations behind, which pop a toast over every screenshot.
  writeFileSync(join(dir, ".vscode", "extensions.json"), `{ "recommendations": [] }\n`);
  return dir;
}
