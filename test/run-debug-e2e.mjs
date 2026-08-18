// Tier 2: does "Start Debugging" on a desktop target actually stop on a Rust breakpoint?
//
//     node test/run-debug-e2e.mjs [project] [target] [file:line]
//
// Opt-in and slower than run-integration.mjs: it needs a real Day project, a host-buildable desktop
// target, and a Rust debugger extension installed. Defaults suit the daybrite monorepo layout - a
// sibling Day-Showcase, breaking where the UI mounts.
//
// The extensions directory is a temp COPY holding only the debugger extension, so the developer's
// own extensions dir is never written to (no auto-update, no state) while the delegate still has
// something to find.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

import { shortTmp, VSCODE_VERSION } from "./e2e/vscode.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const siblings = resolve(root, "..");

const project = process.argv[2] || join(siblings, "Day-Showcase");
const target = process.argv[3] || { darwin: "macos-appkit", win32: "windows-xaml", linux: "linux-gtk" }[process.platform];
// `showcase::root()` runs as the UI mounts, so the program reaches it with no interaction. It also
// lives in the LIB crate, which matters: an Xcode-hosted macos-appkit build supplies its own
// `main`, so nothing in the binary crate's src/main.rs is present to break on.
const breakpoint = process.argv[4] || `${join(project, "src", "lib.rs")}:205`;

if (!existsSync(join(project, "Day.toml"))) {
  console.error(`error: ${project} is not a Day project (no Day.toml)`);
  process.exit(2);
}

const work = shortTmp("day-debug-e2e");
const extDir = join(work, "ext");
mkdirSync(extDir, { recursive: true });

// Copy whichever debugger is present, preferring the order src/debug.ts probes in.
const installed = join(homedir(), ".vscode", "extensions");
const wanted = ["llvm-vs-code-extensions.lldb-dap", "vadimcn.vscode-lldb", "ms-vscode.cpptools"];
const found = existsSync(installed)
  ? wanted.flatMap((id) => readdirSync(installed).filter((d) => d.startsWith(`${id}-`)).slice(0, 1))
  : [];
for (const dir of found) {
  cpSync(join(installed, dir), join(extDir, dir), { recursive: true });
}
console.log(`project: ${project}\ntarget: ${target}\nbreakpoint: ${breakpoint}`);
console.log(found.length ? `debugger: ${found.join(", ")}` : "debugger: none installed (the suite will skip)");

// A multi-root workspace holding the project AND this repo's sibling `day/` checkout, matching what
// scripts/dev.sh opens - which is also what keeps folder-level `day.cliPath` pins out of scope.
const workspace = join(work, "debug-e2e.code-workspace");
const dayRepo = join(siblings, "day");
const folders = [{ path: project }, ...(existsSync(join(dayRepo, "Cargo.toml")) ? [{ path: dayRepo }] : [])];
const { writeFileSync } = await import("node:fs");
writeFileSync(workspace, JSON.stringify({ folders, settings: {} }, null, 2));

let code = 1;
try {
  code = await runTests({
    version: VSCODE_VERSION,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "test", "e2e", "debug-delegation.js"),
    extensionTestsEnv: {
      DAY_DEBUG_E2E_PROJECT: project,
      DAY_DEBUG_E2E_TARGET: target,
      DAY_DEBUG_E2E_BREAKPOINT: breakpoint,
    },
    launchArgs: [workspace, "--disable-workspace-trust", "--extensions-dir", extDir, "--user-data-dir", join(work, "u")],
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
