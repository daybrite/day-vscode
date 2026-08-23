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
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";

import { findDayRepoRoot, resolveCli } from "../cli";
import { State } from "../config";
import { delegateByKey, DesktopLaunchPlan, pickDelegate, planFrom } from "../debug";
import { installRoutes } from "../install";

/** An in-memory Memento, so the selection store can be exercised without touching the real one. */
function fakeMemento(): vscode.Memento {
  const map = new Map<string, unknown>();
  return {
    keys: () => [...map.keys()],
    get: (<T>(key: string, fallback?: T) => (map.has(key) ? (map.get(key) as T) : fallback)) as vscode.Memento["get"],
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, value);
      }
    },
  };
}

/** Last path segment, on either separator. `split("/")` alone returns the WHOLE path on Windows,
 *  where a fixture root is `d:\a\day-vscode\…` — the task lookups below then match nothing. */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

type Check = [name: string, fn: () => Promise<void> | void];

/** The combo the CI leg scaffolded for (macos-appkit / windows-xaml / linux-gtk). */
const COMBO = process.env.DAY_E2E_COMBO ?? "";

const checks: Check[] = [
  [
    "each project keeps its own targets, mode, locale and script",
    async () => {
      // The point of the per-project store: with a dozen apps in one window, ticking a target in
      // one must not tick it in the next, and switching focus must not carry a mode across.
      const state = new State(fakeMemento());
      const sketch = "/w/Day-Sketch";
      const showcase = "/w/Day-Showcase";

      await state.focus(sketch);
      assert.strictEqual(state.focusedRoot, sketch, "focus() must point the cockpit at that project");
      await state.toggleTargetFor(sketch, "macos-appkit");
      await state.update({ profile: "release", locale: "fr" });

      await state.focus(showcase);
      assert.strictEqual(state.focusedRoot, showcase);
      assert.deepStrictEqual(state.selection.targets, [], "a fresh project starts with no targets");
      assert.strictEqual(state.selection.profile, "debug", "mode must not carry across projects");
      assert.strictEqual(state.selection.locale, "", "locale must not carry across projects");
      await state.toggleTargetFor(showcase, "ios-uikit");

      // Focusing back finds the first project exactly as it was left.
      const back = state.selectionFor(sketch);
      assert.deepStrictEqual(back.targets, ["macos-appkit"]);
      assert.strictEqual(back.profile, "release");
      assert.strictEqual(back.locale, "fr");
      assert.deepStrictEqual(state.selectionFor(showcase).targets, ["ios-uikit"]);

      // Editing an UNFOCUSED project (the fan-out tree does this) leaves focus alone.
      await state.updateFor(sketch, { script: "dayscript/demo.yaml" });
      assert.strictEqual(state.focusedRoot, showcase, "updateFor must not steal focus");
      assert.strictEqual(state.selectionFor(sketch).script, "dayscript/demo.yaml");
    },
  ],
  [
    "the extension activates on a workspace containing Day.toml",
    async () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext, "daybrite.day-vscode is not installed in this VS Code");
      await ext.activate();
      assert.ok(ext.isActive, "extension did not activate");
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(folders.length, 2, "expected the two-project fixture workspace");
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
      // proof the CLI ran and its envelope parsed. Every name carries the project it belongs to,
      // which is what keeps two apps' `macos-appkit` in separate terminals.
      for (const name of names) {
        assert.match(name, /^(build|run) \S+ \(.+\)$/, `unexpected task name ${name}`);
      }
      if (COMBO) {
        const has = (verb: string) =>
          names.some((n) => n.startsWith(`${verb} ${COMBO} (`));
        assert.ok(has("build"), `no "build ${COMBO} (<project>)" task in ${names}`);
        assert.ok(has("run"), `no "run ${COMBO} (<project>)" task in ${names}`);
      }
    },
  ],
  [
    "both projects are discovered, and each gets its own tasks",
    async () => {
      // The end this whole feature serves: two apps in one window, each buildable and launchable
      // without one standing in for the other. Tasks are the public proof — they exist only for
      // projects the extension actually discovered and loaded through `day metadata`.
      const tasks = await vscode.tasks.fetchTasks({ type: "day" });
      const projectOf = (name: string) => name.match(/\(([^)]+)\)$/)?.[1];
      const projects = new Set(tasks.map((t) => projectOf(t.name)).filter(Boolean));
      assert.ok(
        projects.has("day-fixture") && projects.has("day-fixture-two"),
        `expected tasks for both fixtures, saw ${JSON.stringify([...projects])}`,
      );
      // Same target, two projects, two distinct tasks — the collision that used to make one app's
      // launch stop the other's.
      if (COMBO) {
        const both = tasks.filter((t) => t.name.startsWith(`run ${COMBO} (`)).map((t) => t.name);
        assert.strictEqual(
          new Set(both).size,
          2,
          `each project needs its own "run ${COMBO}" task, saw ${JSON.stringify(both)}`,
        );
      }
    },
  ],
  [
    "day.toggleVerbose flips the FOCUSED project, and its tasks carry --verbose",
    async () => {
      // Read through the tasks, not through `getConfiguration("day")`: `day.verbose` is
      // folder-scoped now, and the toggle writes it to the focused project's folder — a
      // window-level read cannot see that value at all, and asserting on one would only prove
      // which scope the test itself guessed. The command line is the thing that matters anyway.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const api = (await ext.activate()) as { focusedProject(): string | undefined };
      const focused = api.focusedProject();
      assert.ok(focused, "no focused project to toggle");
      const mine = `(${baseName(focused)})`;

      const tasksFor = async (predicate: (name: string) => boolean) =>
        (await vscode.tasks.fetchTasks({ type: "day" })).filter((t) => predicate(t.name));
      const verboseHere = async () =>
        (await tasksFor((n) => n.endsWith(mine))).every((t) => (t.detail ?? "").includes("--verbose"));

      const before = await verboseHere();
      try {
        if (!before) {
          await vscode.commands.executeCommand("day.toggleVerbose");
        }
        for (const t of await tasksFor((n) => n.endsWith(mine))) {
          assert.ok(
            (t.detail ?? "").includes("--verbose"),
            `task "${t.name}" should carry --verbose: ${t.detail}`,
          );
        }
        // The other project must be untouched — the toggle belongs to one app, not the window.
        for (const t of await tasksFor((n) => !n.endsWith(mine))) {
          assert.ok(
            !(t.detail ?? "").includes("--verbose"),
            `--verbose leaked into another project's task "${t.name}": ${t.detail}`,
          );
        }
        // …and OFF again, which must leave the command line exactly as it was before the feature.
        await vscode.commands.executeCommand("day.toggleVerbose");
        for (const t of await tasksFor((n) => n.endsWith(mine))) {
          assert.ok(
            !(t.detail ?? "").includes("--verbose"),
            `task "${t.name}" should not carry --verbose when off: ${t.detail}`,
          );
        }
      } finally {
        if ((await verboseHere()) !== before) {
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
    "each project can carry its own log level, verbose and env",
    async () => {
      // Folder-scoped settings: one app at trace while the next stays quiet, and the difference
      // has to reach the actual command line rather than just the settings UI.
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(folders.length, 2, "this check needs the two-project fixture");
      const [a, b] = folders;
      const cfgFor = (f: vscode.WorkspaceFolder) => vscode.workspace.getConfiguration("day", f.uri);
      const detailFor = async (f: vscode.WorkspaceFolder): Promise<string> => {
        const tasks = await vscode.tasks.fetchTasks({ type: "day" });
        const name = baseName(f.uri.fsPath);
        const task = tasks.find((t) => t.name.endsWith(`(${name})`));
        assert.ok(task, `no task for ${name} in ${tasks.map((t) => t.name)}`);
        return task.detail ?? "";
      };

      try {
        await cfgFor(a).update("logLevel", "warn", vscode.ConfigurationTarget.WorkspaceFolder);
        await cfgFor(b).update("logLevel", "error", vscode.ConfigurationTarget.WorkspaceFolder);
        await cfgFor(a).update("verbose", true, vscode.ConfigurationTarget.WorkspaceFolder);

        const [da, db] = [await detailFor(a), await detailFor(b)];
        assert.ok(da.includes("--env DAY_LOG=warn"), `first project's level missing: ${da}`);
        assert.ok(db.includes("--env DAY_LOG=error"), `second project's level missing: ${db}`);
        // Verbose set on ONE project must not leak into the other's command line.
        assert.ok(da.includes("--verbose"), `first project should be verbose: ${da}`);
        assert.ok(!db.includes("--verbose"), `verbose leaked into the second project: ${db}`);
      } finally {
        for (const f of [a, b]) {
          await cfgFor(f).update("logLevel", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
          await cfgFor(f).update("verbose", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      }
    },
  ],
  [
    "day.cliSource runs the CLI from source, and refuses a folder that is not a checkout",
    async () => {
      // CLI-development mode: with a day checkout named, every invocation goes through cargo so an
      // edit to day-cli lands in the next build. Asserted on the resolved command rather than by
      // running it, because what matters is which program the extension will spawn.
      const cfg = vscode.workspace.getConfiguration("day");
      const repo = findDayRepoRoot() ?? process.env.DAY_REPO;
      try {
        if (repo) {
          await cfg.update("cliSource", repo, vscode.ConfigurationTarget.Workspace);
          const cli = resolveCli();
          // `cargo` only when it can actually be spawned; the fallback is deliberate, not a bug,
          // so accept either shape and check the one that applies.
          if (cli.command === "cargo") {
            assert.deepStrictEqual(cli.baseArgs.slice(0, 2), ["run", "--manifest-path"]);
            assert.ok(cli.baseArgs.includes("day-cli"), `expected -p day-cli in ${cli.baseArgs}`);
            assert.strictEqual(cli.cwd, repo, "cargo must run in the checkout, not the app");
          } else {
            assert.match(cli.command, /day(\.exe)?$/, `unexpected fallback ${cli.command}`);
          }
        }
        // A folder that is not a day checkout must not hijack the CLI — it falls through to the
        // normal resolution instead of spawning cargo somewhere meaningless.
        await cfg.update("cliSource", os.tmpdir(), vscode.ConfigurationTarget.Workspace);
        const bogus = resolveCli();
        assert.notStrictEqual(
          bogus.cwd,
          os.tmpdir(),
          "a non-checkout day.cliSource must be ignored, not used as a cargo workspace",
        );
      } finally {
        await cfg.update("cliSource", undefined, vscode.ConfigurationTarget.Workspace);
      }
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
      assert.strictEqual(cfg.get("logLevel"), "trace");
      assert.strictEqual(cfg.get("followActiveEditor"), true);
    },
  ],
  [
    "opening a file focuses the project it belongs to",
    async () => {
      // The context rule: which app the Configuration rows, the Run button and the status bar act
      // on follows the file being worked on, so moving between apps needs no extra gesture.
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(folders.length, 2, "this check needs the two-project fixture");
      const roots = folders.map((f) => f.uri.fsPath);
      // `day metadata` reports a canonical root while a workspace folder keeps the path as opened
      // (`/private/tmp/…` vs `/tmp/…` on macOS), so compare the two through the same resolution.
      const real = (p: string): string => {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return p;
        }
      };
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const api = (await ext.activate()) as { focusedProject(): string | undefined };
      const focused = (): string | undefined => {
        const f = api.focusedProject();
        return f === undefined ? undefined : real(f);
      };

      const focusAfterOpening = async (root: string): Promise<string | undefined> => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/Day.toml`));
        await vscode.window.showTextDocument(doc, { preview: false });
        // The focus is set from an async handler on the editor-changed event; wait for it to land
        // rather than assuming the event was delivered synchronously.
        for (let i = 0; i < 50 && focused() !== real(root); i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return focused();
      };

      // Both directions, so this cannot pass by whichever project happened to be focused already.
      for (const root of [roots[1], roots[0], roots[1]]) {
        assert.strictEqual(
          await focusAfterOpening(root),
          real(root),
          `opening a file under ${root} should focus that project`,
        );
      }

      // …and with the behavior turned off, focus stays where the user put it.
      const cfg = vscode.workspace.getConfiguration("day");
      try {
        await cfg.update("followActiveEditor", false, vscode.ConfigurationTarget.Workspace);
        const pinned = focused();
        const other = roots.find((r) => real(r) !== pinned)!;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${other}/Day.toml`));
        await vscode.window.showTextDocument(doc, { preview: false });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(
          focused(),
          pinned,
          "day.followActiveEditor=false must stop the editor from changing focus",
        );
      } finally {
        await cfg.update("followActiveEditor", undefined, vscode.ConfigurationTarget.Workspace);
      }
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
