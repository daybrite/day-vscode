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

import { delegateByKey, DesktopLaunchPlan, pickDelegate, planFrom } from "../debug";
import { installRoutes } from "../install";

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
    "day.toggleVerbose flips the setting, and the tasks it generates carry --verbose",
    async () => {
      const cfg = () => vscode.workspace.getConfiguration("day").get<boolean>("verbose", false);
      const dayTasks = async () => await vscode.tasks.fetchTasks({ type: "day" });
      const before = cfg();
      try {
        // ON: every build and run task should now name the flag. `detail` is the rendered command
        // line the task will execute, so asserting on it covers the whole path from the checkbox
        // to the process argv — not merely that a setting changed.
        if (!cfg()) {
          await vscode.commands.executeCommand("day.toggleVerbose");
        }
        assert.strictEqual(cfg(), true, "toggling did not turn day.verbose on");
        for (const t of await dayTasks()) {
          assert.ok(
            (t.detail ?? "").includes("--verbose"),
            `task "${t.name}" should carry --verbose: ${t.detail}`,
          );
        }
        // …and OFF again, which must leave the command line exactly as it was before the feature.
        await vscode.commands.executeCommand("day.toggleVerbose");
        assert.strictEqual(cfg(), false, "toggling did not turn day.verbose off");
        for (const t of await dayTasks()) {
          assert.ok(
            !(t.detail ?? "").includes("--verbose"),
            `task "${t.name}" should not carry --verbose when off: ${t.detail}`,
          );
        }
      } finally {
        if (cfg() !== before) {
          await vscode.commands.executeCommand("day.toggleVerbose");
        }
      }
    },
  ],
  [
    "day.logLevel rides every run task as --env DAY_LOG, trace by default, extraEnv winning",
    async () => {
      const cfg = vscode.workspace.getConfiguration("day");
      const runTasks = async () =>
        (await vscode.tasks.fetchTasks({ type: "day" })).filter((t) => t.name.startsWith("run "));
      try {
        // Default: trace, so a fresh install shows everything (the per-statement SQL firehose
        // included) without any setup. `detail` is the rendered command line, so this covers
        // the whole path from the setting to the process argv.
        for (const t of await runTasks()) {
          assert.ok(
            (t.detail ?? "").includes("--env DAY_LOG=trace"),
            `task "${t.name}" should carry --env DAY_LOG=trace by default: ${t.detail}`,
          );
        }
        // A chosen level replaces the default…
        await cfg.update("logLevel", "info", vscode.ConfigurationTarget.Global);
        for (const t of await runTasks()) {
          assert.ok(
            (t.detail ?? "").includes("--env DAY_LOG=info"),
            `task "${t.name}" should carry the chosen level: ${t.detail}`,
          );
        }
        // …and a hand-written DAY_LOG in day.extraEnv beats the setting.
        await cfg.update("extraEnv", { DAY_LOG: "warn" }, vscode.ConfigurationTarget.Global);
        for (const t of await runTasks()) {
          const detail = t.detail ?? "";
          assert.ok(
            detail.includes("--env DAY_LOG=warn") && !detail.includes("DAY_LOG=info"),
            `task "${t.name}" should let extraEnv's DAY_LOG win: ${detail}`,
          );
        }
      } finally {
        await cfg.update("logLevel", undefined, vscode.ConfigurationTarget.Global);
        await cfg.update("extraEnv", undefined, vscode.ConfigurationTarget.Global);
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
    "the install routes put a Rust-free option first on every platform",
    () => {
      // The ordering is the whole point of the table: someone without the CLI usually has no Rust
      // toolchain either, so `cargo install` must never be the first thing offered.
      for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
        const routes = installRoutes(platform);
        assert.ok(routes.length >= 2, `${platform}: expected more than one route`);
        assert.match(
          routes[0].command,
          /curl|irm/,
          `${platform}: the first route should download a prebuilt binary, got ${routes[0].command}`,
        );
        assert.strictEqual(
          routes[routes.length - 1].command,
          "cargo install day-cli",
          `${platform}: cargo should be the last resort`,
        );
      }
      // Homebrew is macOS-only here; offering it on Linux would be a guess about the host.
      assert.ok(installRoutes("darwin").some((r) => r.command.includes("brew")));
      assert.ok(!installRoutes("win32").some((r) => r.command.includes("brew")));
    },
  ],
  [
    "the day configuration carries its documented defaults",
    () => {
      const cfg = vscode.workspace.getConfiguration("day");
      assert.strictEqual(cfg.get("defaultProfile"), "debug");
      assert.strictEqual(cfg.get("mcp.enabled"), true);
      assert.strictEqual(cfg.get("script.keepAppRunning"), true);
      assert.strictEqual(cfg.get("debug.adapter"), "auto");
      assert.strictEqual(cfg.get("verbose"), false);
    },
  ],
  [
    "breakpoints are contributed for Rust",
    () => {
      // Without this contribution VS Code refuses to set a breakpoint in a .rs file at all, and a
      // delegated session would launch with nothing to stop on.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const languages: string[] = (ext.packageJSON?.contributes?.breakpoints ?? []).map(
        (b: { language: string }) => b.language,
      );
      assert.ok(languages.includes("rust"), `breakpoints contributes ${JSON.stringify(languages)}`);
    },
  ],
  [
    "each debug delegate shapes the launch plan the way its adapter declares",
    () => {
      // The adapters disagree about the environment, and getting it wrong fails at debug time on
      // someone else's machine. These shapes are read from each extension's own
      // `configurationAttributes`: lldb-dap and CodeLLDB take an `env` map, cpptools takes
      // `environment` as name/value pairs plus an MIMode everywhere but Windows.
      const plan: DesktopLaunchPlan = {
        program: "/tmp/app/showcase",
        args: [],
        cwd: "/tmp/app",
        env: { DAY_APP_ID: "dev.daybrite.showcase" },
        wrapper: null,
      };
      const env = { DAY_APP_ID: "dev.daybrite.showcase", DAY_LOCALE: "fr" };

      for (const key of ["lldb-dap", "codelldb"] as const) {
        const d = delegateByKey(key);
        assert.ok(d, `no delegate ${key}`);
        const a = d.attributes(plan, env);
        assert.deepStrictEqual(a.env, env, `${key} should pass env as a map`);
        assert.strictEqual(a.program, plan.program);
        assert.strictEqual(a.cwd, plan.cwd);
        assert.ok(!("environment" in a), `${key} should not use cpptools' \`environment\` key`);
      }
      assert.strictEqual(delegateByKey("lldb-dap")?.debugType(), "lldb-dap");
      assert.strictEqual(delegateByKey("codelldb")?.debugType(), "lldb");

      const cpp = delegateByKey("cpptools");
      assert.ok(cpp);
      const a = cpp.attributes(plan, env);
      assert.ok(!("env" in a), "cpptools takes `environment`, not `env`");
      assert.deepStrictEqual(a.environment, [
        { name: "DAY_APP_ID", value: "dev.daybrite.showcase" },
        { name: "DAY_LOCALE", value: "fr" },
      ]);
      const windows = process.platform === "win32";
      assert.strictEqual(cpp.debugType(), windows ? "cppvsdbg" : "cppdbg");
      // cppvsdbg drives the Windows debugger directly; only the MI-based cppdbg needs telling.
      assert.strictEqual("MIMode" in a, !windows);
    },
  ],
  [
    "pinning day.debug.adapter to none disables delegation",
    async () => {
      const cfg = vscode.workspace.getConfiguration("day");
      const previous = cfg.get<string>("debug.adapter");
      try {
        await cfg.update("debug.adapter", "none", vscode.ConfigurationTarget.Workspace);
        assert.strictEqual(
          pickDelegate(),
          undefined,
          "a pinned `none` must fall back to the launch-only adapter",
        );
      } finally {
        await cfg.update("debug.adapter", previous, vscode.ConfigurationTarget.Workspace);
      }
    },
  ],
  [
    "the launch plan is read out of the CLI's NDJSON result event",
    () => {
      const logged: string[] = [];
      const log = (m: string) => logged.push(m);
      // Shaped like real `day build --format json` output: day's own status lines go to stderr, so
      // stdout is result events only — but the parser must still survive a stray non-JSON line.
      const stream = [
        "not json at all",
        JSON.stringify({
          event: "result",
          command: "build",
          ok: true,
          targets: [
            {
              target: "linux-gtk",
              ok: true,
              artifacts: [{ path: "/app/build/showcase" }],
              launch: {
                program: "/app/build/showcase",
                args: [],
                cwd: "/app",
                env: { DAY_IMAGE_ROOT: "/app/resource/images" },
                wrapper: null,
              },
            },
          ],
        }),
        "",
      ].join("\n");

      const plan = planFrom(stream, "linux-gtk", log);
      assert.ok(plan, `no plan parsed; log: ${logged.join(" | ")}`);
      assert.strictEqual(plan.program, "/app/build/showcase");
      assert.deepStrictEqual(plan.env, { DAY_IMAGE_ROOT: "/app/resource/images" });

      // A target the CLI reported without a plan (a device or browser runtime) is not an error —
      // it means "run this one without a debugger", and it has to say so rather than throw.
      const noPlan = JSON.stringify({
        event: "result",
        command: "build",
        ok: true,
        targets: [{ target: "android-mdc", ok: true, artifacts: [{ path: "/app/app.apk" }] }],
      });
      assert.strictEqual(planFrom(noPlan, "android-mdc", log), undefined);
      assert.ok(
        logged.some((m) => m.includes("android-mdc")),
        `expected a logged reason, got ${JSON.stringify(logged)}`,
      );
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
