// Tier 1 of the end-to-end story: run out/test/suite.js inside a real extension host.
//
//     node test/run-integration.mjs            # uses DAY_BIN or `day` from PATH
//
// @vscode/test-electron downloads the pinned VS Code, launches it with the extension loaded from
// this checkout, and runs the suite in-process. Fast (about a minute cold, seconds warm) and with
// no UI automation in it, so it belongs on the PR path; test/e2e/drive.mjs is the slow half.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

import { fixtureParent, hostCombo, scaffold } from "./e2e/fixture.mjs";
import { shortTmp, VSCODE_VERSION } from "./e2e/vscode.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const dayBin = process.env.DAY_BIN || "day";
const work = shortTmp("day-vsc-int");
const workspace = scaffold({ dayBin, parent: fixtureParent(work) });
console.log(`fixture: ${workspace}\nday CLI: ${dayBin}\nVS Code: ${VSCODE_VERSION}`);

const code = await runTests({
  version: VSCODE_VERSION,
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, "out", "test", "suite.js"),
  extensionTestsEnv: { DAY_E2E_COMBO: hostCombo() },
  // A short user-data-dir: VS Code's IPC socket lives under it and blows past the 103-character
  // sun_path limit if it sits deep inside a temp tree.
  launchArgs: [workspace, "--disable-workspace-trust", "--user-data-dir", join(work, "u")],
});
process.exit(code);
