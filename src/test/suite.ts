// Integration suite — runs INSIDE the extension host, so the whole `vscode` API is in scope.
// Launched by test/run-integration.mjs through @vscode/test-electron, against a workspace that
// `day new app` scaffolded (test/e2e/fixture.mjs) with a real `day` CLI on hand.
//
// The assertions deliberately go through public surfaces rather than the extension's internals:
// what a user sees is the command list, the task list, and the tree. The task list matters most —
// tasks exist only if `day metadata --json` was spawned, parsed, and turned into targets, so one
// assertion covers the whole CLI seam.
//
// No mocha: the whole suite is a handful of named checks, and a test framework would be a
// dependency shipped for four helper functions. `run()` throws on the first failure, which is
// exactly what the runner reports.

import * as assert from "assert";
import * as vscode from "vscode";

type Check = [name: string, fn: () => Promise<void> | void];

/** The combo the CI leg scaffolded for (macos-appkit / windows-xaml / linux-gtk). */
const COMBO = process.env.DAY_E2E_COMBO ?? "";

const checks: Check[] = [
  [
    "the extension activates on a workspace containing Day.toml",
    async () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext, "daybrite.day-vscode is not installed in this VS Code");
      await ext.activate();
      assert.ok(ext.isActive, "extension did not activate");
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(folders.length, 1, "expected exactly one workspace folder");
    },
  ],
  [
    "every contributed command is registered",
    async () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const contributed: string[] = (ext.packageJSON?.contributes?.commands ?? []).map(
        (c: { command: string }) => c.command,
      );
      assert.ok(contributed.length > 0, "package.json contributes no commands");
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = contributed.filter((c) => !registered.has(c));
      assert.deepStrictEqual(missing, [], `commands contributed but never registered: ${missing}`);
    },
  ],
  [
    "the task provider resolves a build and a run task per target",
    async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: "day" });
      const names = tasks.map((t) => t.name).sort();
      assert.ok(names.length >= 2, `expected day tasks, got ${JSON.stringify(names)}`);
      // Tasks come from the target list `day metadata --json` reported, so their presence is
      // proof the CLI ran and its envelope parsed.
      for (const name of names) {
        assert.match(name, /^(build|run) \S+$/, `unexpected task name ${name}`);
      }
      if (COMBO) {
        assert.ok(names.includes(`build ${COMBO}`), `no "build ${COMBO}" task in ${names}`);
        assert.ok(names.includes(`run ${COMBO}`), `no "run ${COMBO}" task in ${names}`);
      }
    },
  ],
  [
    "the tree view is registered and reveals the project",
    async () => {
      // The view id is what `views.day[0].id` contributes; focusing it is the same command the
      // activity-bar icon runs, and it throws if the view was never registered.
      await vscode.commands.executeCommand("dayTargets.focus");
    },
  ],
  [
    "the day configuration carries its documented defaults",
    () => {
      const cfg = vscode.workspace.getConfiguration("day");
      assert.strictEqual(cfg.get("defaultProfile"), "debug");
      assert.strictEqual(cfg.get("mcp.enabled"), true);
      assert.strictEqual(cfg.get("script.keepAppRunning"), true);
    },
  ],
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`  ✗ ${name}\n    ${message}`);
      failures.push(name);
    }
  }
  console.log(`${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length) {
    throw new Error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  }
}
