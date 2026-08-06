// Shared harness for the end-to-end run: get a VS Code, install the packaged extension into it,
// launch it under Playwright, and capture what is on screen.
//
// Two deliberate choices:
//
//   * The binary path comes from @vscode/test-electron, never from a hardcoded path. On macOS the
//     app bundle's `Contents/MacOS/Electron` symlink is gone as of 1.131 — the executable is named
//     by `CFBundleExecutable` (`Code`) — and test-electron resolves that for us. Hardcoding the
//     old path fails as an instant, silent process exit.
//   * Settings are written into the user-data-dir BEFORE launch rather than driven through
//     commands afterwards. A screenshot has to be reproducible, and the recommendation toast, the
//     chat panel, and the release-notes editor all appear before any command could dismiss them.
//
// The extension under test is the .vsix a user installs, not `--extensionDevelopmentPath`, so the
// packaging step is part of what this exercises.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { _electron as electron } from "playwright";

/**
 * Pin the VS Code build. An unpinned `stable` re-downloads on every release, invalidates the
 * cache key, and changes the pixels under the screenshots; CI overrides it only on purpose.
 */
export const VSCODE_VERSION = process.env.DAY_E2E_VSCODE_VERSION || "1.132.0";

/** Settings that make a capture reproducible and keep other products out of the frame. */
const QUIET_SETTINGS = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  // The chat view opens in the secondary side bar on a fresh profile and eats a third of the
  // frame; nothing here is about it.
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.tips.enabled": false,
  "workbench.statusBar.visible": true,
  "workbench.editor.empty.hint": "hidden",
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "window.commandCenter": false,
  "chat.commandCenter.enabled": false,
  "editor.minimap.enabled": false,
  "explorer.confirmDragAndDrop": false,
  "terminal.integrated.gpuAcceleration": "off",
};

/** Download (or reuse) the pinned VS Code and return its executable path. */
export async function resolveVSCode() {
  return downloadAndUnzipVSCode(VSCODE_VERSION);
}

/**
 * A working directory with a SHORT absolute path. VS Code opens `<user-data-dir>/<ver>-main.sock`,
 * and a Unix domain socket path over 103 characters fails with `listen EINVAL` — which surfaces as
 * VS Code exiting the instant it starts, with nothing in the log that names a path. macOS's
 * `os.tmpdir()` is deep enough to hit this on its own once a couple of subdirectories are added.
 */
export function shortTmp(prefix) {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return mkdtempSync(join(base, `${prefix}-`));
}

/**
 * Install a .vsix into `extensionsDir` using that build's own CLI.
 *
 * On Windows the resolved CLI is `bin\code.cmd`, and Node refuses to spawn a `.cmd` without a
 * shell — so the shell goes on, and every argument gets quoted, because with a shell the
 * arguments are re-parsed and a path with a space would split.
 */
export function installVsix(exe, vsix, extensionsDir, userDataDir) {
  const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const windows = process.platform === "win32";
  const quote = (a) => (windows ? `"${a}"` : a);
  const res = spawnSync(
    quote(cli),
    [
      ...baseArgs,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
      "--install-extension",
      vsix,
      "--force",
    ].map(quote),
    // A deadline, because `code --install-extension` talks to a marketplace and a keychain and
    // has no timeout of its own. SIGKILL, not SIGTERM: the point is that nothing here can wedge
    // the job.
    { encoding: "utf8", stdio: "pipe", shell: windows, timeout: 180_000, killSignal: "SIGKILL" },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0) {
    throw new Error(`installing ${vsix} failed (exit ${res.status}):\n${out}`);
  }
  return out.trim();
}

/**
 * Launch VS Code on `workspace` with the extension already installed.
 *
 * `userDataDir` must be SHORT: VS Code opens a Unix domain socket under it, and the 103-character
 * sun_path limit shows up as `listen EINVAL` and an immediate exit, not as a path error.
 */
export async function launchVSCode({
  exe,
  workspace,
  extensionsDir,
  userDataDir,
  settings = {},
  openFiles = [],
}) {
  mkdirSync(join(userDataDir, "User"), { recursive: true });
  writeFileSync(
    join(userDataDir, "User", "settings.json"),
    JSON.stringify({ ...QUIET_SETTINGS, ...settings }, null, 2),
  );

  const app = await electron.launch({
    executablePath: exe,
    args: [
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--disable-telemetry",
      "--no-sandbox",
      workspace,
      // Opened alongside the folder: an editor with the project's own code in it is what the
      // cockpit is meant to sit beside, and an empty editor area photographs as a watermark.
      ...openFiles,
    ],
    timeout: 180_000,
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 180_000 });
  await win.setViewportSize({ width: 1440, height: 900 });
  return { app, win };
}

/**
 * Capture the whole desktop, not just VS Code's own window.
 *
 * Playwright screenshots the Electron page, which stops at the window border — and the point of
 * several of these captures is the Day app's NATIVE window sitting beside the editor that
 * launched it. Each OS needs its own tool:
 *
 *   macOS    `screencapture`, preinstalled.
 *   Linux    ImageMagick `import` against the X root; the CI job runs under one xvfb, so the root
 *            holds both VS Code and the app.
 *   Windows  PowerShell + System.Drawing CopyFromScreen over the virtual screen bounds.
 *
 * Returns true when a file was written. A missing tool is reported, never fatal: a screenshot is
 * evidence, and evidence going missing must not fail a run that otherwise passed.
 *
 * On a CI runner the desktop holds nothing but these two windows. On a developer machine it holds
 * whatever else is open, so a local `npm run test:e2e` writes a picture of your screen into
 * build/screenshots/ — fine for checking the harness, not something to publish unread.
 */
export function captureDesktop(path) {
  // 30 seconds is far more than any of these need, and the timeout is the entire point: macOS
  // `screencapture` blocks forever on a runner that has no Screen Recording grant to give,
  // waiting on a TCC prompt no one will ever answer. A screenshot is evidence; evidence must not
  // be able to wedge the job that produces it.
  const run = (cmd, args) =>
    spawnSync(cmd, args, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
  let res;
  if (process.platform === "darwin") {
    // -x no shutter sound, -m main display only (a second monitor is not part of the story).
    res = run("screencapture", ["-x", "-m", path]);
  } else if (process.platform === "linux") {
    res = run("import", ["-window", "root", "-silent", path]);
  } else {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
    res = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (res.error?.code === "ETIMEDOUT" || res.signal === "SIGKILL") {
    console.warn(`  ! desktop capture timed out after 30s (${process.platform}) — skipping`);
    return false;
  }
  if (res.status !== 0) {
    console.warn(`  ! desktop capture failed: ${(res.stderr || res.stdout || "").trim()}`);
    return false;
  }
  return true;
}
