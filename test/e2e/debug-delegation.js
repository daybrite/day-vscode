// Runs INSIDE a real extension host: drives a real "Start Debugging" and asserts the delegation
// actually reached a debugger and stopped the program.
//
// This test exists because the seam it covers broke silently. `resolveDebugConfiguration` returning
// a config whose `type` names a DIFFERENT debugger looks like it should work, resolves cleanly, and
// starts nothing at all - VS Code resolves against the original type. Nothing below the extension's
// own unit checks noticed, because every one of them stopped at "we returned the right object".
//
// So the assertions here are deliberately about observable end state, not about our own return
// values: a session of the delegate's type exists, a breakpoint reported `verified`, and the
// adapter sent a `stopped` event with reason "breakpoint".
const assert = require("assert");
const vscode = require("vscode");

const PROJECT = process.env.DAY_DEBUG_E2E_PROJECT;
const TARGET = process.env.DAY_DEBUG_E2E_TARGET;
/** A `<file>:<line>` the app reaches unaided while starting up. Split on the LAST colon, so an
 *  absolute Windows path (`C:\src\...`) survives. */
const BP = process.env.DAY_DEBUG_E2E_BREAKPOINT || "";
const BP_FILE = BP.slice(0, BP.lastIndexOf(":"));
const BP_LINE = BP.slice(BP.lastIndexOf(":") + 1);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async () => {
  assert.ok(PROJECT && TARGET && BP_FILE && BP_LINE, "DAY_DEBUG_E2E_* env is incomplete");

  const ext = vscode.extensions.getExtension("daybrite.day-vscode");
  assert.ok(ext, "daybrite.day-vscode is not loaded");
  await ext.activate();

  // Skip rather than fail where no Rust debugger is installed: the delegate has nothing to delegate
  // to, and that is a property of the machine, not a regression.
  const debuggers = ["llvm-vs-code-extensions.lldb-dap", "vadimcn.vscode-lldb", "ms-vscode.cpptools"];
  if (!debuggers.some((id) => vscode.extensions.getExtension(id))) {
    console.log("  - skipped: no Rust debugger extension installed");
    return;
  }

  const stops = [];
  const verified = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory("*", {
    createDebugAdapterTracker: () => ({
      onDidSendMessage(m) {
        if (m.type === "event" && m.event === "stopped") { stops.push(m.body || {}); }
        if (m.type === "response" && m.command === "setBreakpoints") {
          for (const b of (m.body || {}).breakpoints || []) { verified.push(b.verified); }
        }
      },
    }),
  });

  const sessions = [];
  const sub = vscode.debug.onDidStartDebugSession((s) => sessions.push(s.type));

  vscode.debug.addBreakpoints([
    new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(BP_FILE), new vscode.Position(Number(BP_LINE) - 1, 0)),
    ),
  ]);

  try {
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: "day",
      request: "launch",
      name: `debug-e2e ${TARGET}`,
      target: TARGET,
      project: PROJECT,
      profile: "debug",
    });
    // The delegated session is started separately, so `startDebugging`'s own answer says nothing;
    // wait for the session and the stop instead. Generous: this includes a build.
    for (let i = 0; i < 150 && !stops.length; i++) { await wait(2000); }

    assert.ok(
      sessions.some((t) => t !== "day"),
      `no delegated session started (saw ${JSON.stringify(sessions)}) - ` +
        "the `day` config was probably returned with a rewritten type instead of started directly",
    );
    assert.ok(verified.includes(true), `no breakpoint bound (verified: ${JSON.stringify(verified)})`);
    assert.ok(
      stops.some((s) => s.reason === "breakpoint"),
      `the program never stopped on a breakpoint (stops: ${JSON.stringify(stops.map((s) => s.reason))})`,
    );
    console.log(`  ✓ delegated to ${sessions.filter((t) => t !== "day").join(",")} and stopped on a breakpoint`);
  } finally {
    try { await vscode.debug.stopDebugging(); } catch { /* nothing running */ }
    await wait(2000);
    sub.dispose();
    tracker.dispose();
  }
};
