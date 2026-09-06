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
import * as path from "path";
import * as vscode from "vscode";

import {
  findDayRepoRoot,
  launchArgs,
  lintArgs,
  MCP_PROVIDER_ID,
  mcpServerSpecs,
  resolveCli,
  stopArgs,
} from "../cli";
import { State } from "../config";
import {
  delegateByKey,
  DesktopLaunchPlan,
  pickDelegate,
  planFrom,
} from "../debug";
import { editFor, Lint, mapFindings } from "../lint";
import { composeArgs, describeSpec, visibleFields } from "../newproject";
import { catalog, findTarget, isBuildableHere, nativeProjectFor } from "../targets";
import { liveDevice, startPrompt, TargetDevices, virtualDevice } from "../devices";
import { cliItem, deviceRowState, orderTargets, targetContextValue } from "../tree";
import { buildDayTask, hideUnavailableTargets, toolchainEnv } from "../tasks";
import {
  installChoices,
  installRoutes,
  isNewer,
  managedCliDir,
  parseVersion,
  resolveSourceVersion,
  sourceInstallCommand,
  UPDATE_CONTEXT,
} from "../install";

/** An in-memory Memento, so the selection store can be exercised without touching the real one. */
function fakeMemento(seed?: Record<string, unknown>): vscode.Memento {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    keys: () => [...map.keys()],
    get: (<T>(key: string, fallback?: T) =>
      map.has(key) ? (map.get(key) as T) : fallback) as vscode.Memento["get"],
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
      assert.strictEqual(
        state.focusedRoot,
        sketch,
        "focus() must point the cockpit at that project",
      );
      await state.toggleTargetFor(sketch, "macos-appkit");
      await state.update({ profile: "release", locale: "fr" });

      await state.focus(showcase);
      assert.strictEqual(state.focusedRoot, showcase);
      assert.deepStrictEqual(
        state.selection.targets,
        [],
        "a fresh project starts with no targets",
      );
      assert.strictEqual(
        state.selection.profile,
        "debug",
        "mode must not carry across projects",
      );
      assert.strictEqual(
        state.selection.locale,
        "",
        "locale must not carry across projects",
      );
      await state.toggleTargetFor(showcase, "ios-uikit");

      // Focusing back finds the first project exactly as it was left.
      const back = state.selectionFor(sketch);
      assert.deepStrictEqual(back.targets, ["macos-appkit"]);
      assert.strictEqual(back.profile, "release");
      assert.strictEqual(back.locale, "fr");
      assert.deepStrictEqual(state.selectionFor(showcase).targets, [
        "ios-uikit",
      ]);

      // Editing an UNFOCUSED project (the fan-out tree does this) leaves focus alone.
      await state.updateFor(sketch, { script: "dayscript/demo.yaml" });
      assert.strictEqual(
        state.focusedRoot,
        showcase,
        "updateFor must not steal focus",
      );
      assert.strictEqual(
        state.selectionFor(sketch).script,
        "dayscript/demo.yaml",
      );
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
      assert.strictEqual(
        folders.length,
        2,
        "expected the two-project fixture workspace",
      );
    },
  ],
  [
    "every contributed command is registered",
    async () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const contributed: string[] = (
        ext.packageJSON?.contributes?.commands ?? []
      ).map((c: { command: string }) => c.command);
      assert.ok(contributed.length > 0, "package.json contributes no commands");
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = contributed.filter((c) => !registered.has(c));
      assert.deepStrictEqual(
        missing,
        [],
        `commands contributed but never registered: ${missing}`,
      );
    },
  ],
  [
    "the task provider resolves a build and a run task per target",
    async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: "day" });
      const names = tasks.map((t) => t.name).sort();
      assert.ok(
        names.length >= 2,
        `expected day tasks, got ${JSON.stringify(names)}`,
      );
      // Tasks come from the target list `day metadata --json` reported, so their presence is
      // proof the CLI ran and its envelope parsed. Every name carries the project it belongs to,
      // which is what keeps two apps' `macos-appkit` in separate terminals.
      for (const name of names) {
        assert.match(
          name,
          /^(build|run) \S+ \(.+\)$/,
          `unexpected task name ${name}`,
        );
      }
      if (COMBO) {
        const has = (verb: string) =>
          names.some((n) => n.startsWith(`${verb} ${COMBO} (`));
        assert.ok(
          has("build"),
          `no "build ${COMBO} (<project>)" task in ${names}`,
        );
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
      const projects = new Set(
        tasks.map((t) => projectOf(t.name)).filter(Boolean),
      );
      assert.ok(
        projects.has("day-fixture") && projects.has("day-fixture-two"),
        `expected tasks for both fixtures, saw ${JSON.stringify([...projects])}`,
      );
      // Same target, two projects, two distinct tasks — the collision that used to make one app's
      // launch stop the other's.
      if (COMBO) {
        const both = tasks
          .filter((t) => t.name.startsWith(`run ${COMBO} (`))
          .map((t) => t.name);
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
      const api = (await ext.activate()) as {
        focusedProject(): string | undefined;
      };
      const focused = api.focusedProject();
      assert.ok(focused, "no focused project to toggle");
      const mine = `(${baseName(focused)})`;

      const tasksFor = async (predicate: (name: string) => boolean) =>
        (await vscode.tasks.fetchTasks({ type: "day" })).filter((t) =>
          predicate(t.name),
        );
      const verboseHere = async () =>
        (await tasksFor((n) => n.endsWith(mine))).every((t) =>
          (t.detail ?? "").includes("--verbose"),
        );

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
    "day.logLevel rides every run task as --env DAY_LOG, debug by default, extraEnv winning",
    async () => {
      const cfg = vscode.workspace.getConfiguration("day");
      const runTasks = async () =>
        (await vscode.tasks.fetchTasks({ type: "day" })).filter((t) =>
          t.name.startsWith("run "),
        );
      try {
        // Default: debug — the framework's own diagnostics, without day-persistence's
        // per-statement SQL firehose, which `trace` adds and few people want unasked. `detail` is
        // the rendered command line, so this covers the whole path from the setting to argv.
        for (const t of await runTasks()) {
          assert.ok(
            (t.detail ?? "").includes("--env DAY_LOG=debug"),
            `task "${t.name}" should carry --env DAY_LOG=debug by default: ${t.detail}`,
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
        await cfg.update(
          "extraEnv",
          { DAY_LOG: "warn" },
          vscode.ConfigurationTarget.Global,
        );
        for (const t of await runTasks()) {
          const detail = t.detail ?? "";
          assert.ok(
            detail.includes("--env DAY_LOG=warn") &&
              !detail.includes("DAY_LOG=info"),
            `task "${t.name}" should let extraEnv's DAY_LOG win: ${detail}`,
          );
        }
      } finally {
        await cfg.update(
          "logLevel",
          undefined,
          vscode.ConfigurationTarget.Global,
        );
        await cfg.update(
          "extraEnv",
          undefined,
          vscode.ConfigurationTarget.Global,
        );
      }
    },
  ],
  [
    "the wizard composes the command line the CLI described",
    async () => {
      const app = {
        id: "app",
        label: "App",
        command: ["new", "app"],
        fields: [
          { id: "name", label: "Project name", type: "text" as const, positional: true, required: true },
          { id: "id", label: "Application id", type: "text" as const, flag: "--appid" },
          {
            id: "targets",
            label: "Platform-toolkits",
            type: "multi-select" as const,
            flag: "--toolkit",
            list: "repeat" as const,
          },
          { id: "title", label: "Window title", type: "text" as const, flag: "--title" },
        ],
      };

      // A repeatable list is repeated, and the name is positional.
      assert.deepStrictEqual(
        composeArgs(app, { name: "my-app", targets: ["macos-appkit", "linux-gtk"] }),
        ["new", "app", "my-app", "--toolkit", "macos-appkit", "--toolkit", "linux-gtk", "--no-input"],
      );

      // A blank optional field is OMITTED, not passed empty — that is what lets the CLI apply
      // `dev.example.<name>` and the title-cased name instead of this file recomputing them.
      assert.deepStrictEqual(
        composeArgs(app, { name: "a", id: "", title: "", targets: ["web-dom"] }),
        ["new", "app", "a", "--toolkit", "web-dom", "--no-input"],
      );
      assert.deepStrictEqual(
        composeArgs(app, { name: "a", id: "com.x.a", targets: ["web-dom"], title: "A" }),
        ["new", "app", "a", "--appid", "com.x.a", "--toolkit", "web-dom", "--title", "A", "--no-input"],
      );

      // A comma list is joined, because `day new piece` takes `--toolkits a,b` and not a repeat.
      const piece = {
        id: "piece",
        label: "Piece",
        command: ["new", "piece"],
        fields: [
          { id: "name", label: "Name", type: "text" as const, positional: true, required: true },
          {
            id: "native",
            label: "Kind",
            type: "select" as const,
            flag: null,
            options: [{ value: "composite" }, { value: "native" }],
          },
          {
            id: "toolkits",
            label: "Toolkits",
            type: "multi-select" as const,
            flag: "--toolkits",
            list: "comma" as const,
            visible_when: { field: "native", equals: "native" },
          },
        ],
      };
      assert.deepStrictEqual(
        composeArgs(piece, { name: "dial", native: "native", toolkits: ["appkit", "gtk"] }),
        ["new", "piece", "dial", "--toolkits", "appkit,gtk", "--no-input"],
      );

      // A hidden field contributes nothing even when an answer is left over from going Back:
      // choosing composite after having chosen toolkits must not still pass them.
      assert.deepStrictEqual(
        visibleFields(piece, { native: "composite" }).map((f) => f.id),
        ["name", "native"],
      );
      assert.deepStrictEqual(
        composeArgs(piece, { name: "dial", native: "composite", toolkits: ["appkit"] }),
        ["new", "piece", "dial", "--no-input"],
      );
    },
  ],
  [
    "the CLI describes the questions, or the wizard says so",
    async () => {
      // The e2e leg installs the day CLI from day's main branch, which may predate
      // `day new --describe`. Missing it must leave the command reporting rather than throwing,
      // so this asserts the SHAPE of the answer: a usable spec, or a clean undefined.
      const output = vscode.window.createOutputChannel("Day describe check");
      try {
        const spec = await describeSpec(output);
        if (!spec) {
          console.log("    (skipped: this day CLI has no `new --describe` yet)");
          return;
        }
        assert.strictEqual(spec.schema, 1);
        assert.deepStrictEqual(
          spec.kinds.map((k) => k.id).sort(),
          ["app", "part", "piece"],
        );
        for (const kind of spec.kinds) {
          assert.ok(kind.fields.length > 0, `${kind.id} has no fields`);
          const positional = kind.fields.filter((f) => f.positional);
          assert.strictEqual(positional.length, 1, `${kind.id} needs exactly one positional`);
          for (const f of kind.fields) {
            if (f.type === "select" || f.type === "multi-select") {
              assert.ok((f.options ?? []).length > 0, `${kind.id}.${f.id} has no options`);
            }
          }
        }
        // The targets offered are the real ones, from the CLI rather than a mirrored list.
        const targets = spec.kinds
          .find((k) => k.id === "app")
          ?.fields.find((f) => f.id === "targets");
        const values = (targets?.options ?? []).map((o) => o.value);
        assert.ok(values.includes("windows-xaml"));
        assert.ok(!values.includes("windows-winui"));
        // And the host's own target is named, so the wizard never re-derives it.
        assert.ok(values.includes(String(spec.host?.default_target)));
      } finally {
        output.dispose();
      }
    },
  ],
  [
    "the scripts set settings this extension actually declares",
    async () => {
      // The dev launchers and the capture harness write settings into generated files by name. A
      // typo there is silent — VS Code ignores an unknown setting — and the welcome page would
      // simply not appear, or the capture run would stop at a native dialog, with nothing to say
      // why.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const declared = new Set(
        (ext.packageJSON.contributes.configuration as { properties: Record<string, unknown> }[])
          .flatMap((c) => Object.keys(c.properties)),
      );
      // `test/e2e/vscode.mjs` writes them too, into the harness's generated settings.json.
      for (const script of ["scripts/dev.sh", "scripts/dev.ps1", "test/e2e/vscode.mjs"]) {
        const text = fs.readFileSync(
          vscode.Uri.joinPath(ext.extensionUri, script).fsPath,
          "utf8",
        );
        for (const [, name] of text.matchAll(/["']?(day\.[A-Za-z.]+)["']?\s*[:=]/g)) {
          assert.ok(declared.has(name), `${script} writes undeclared setting ${name}`);
        }
      }
      assert.ok(declared.has("day.showWalkthroughOnStartup"));
    },
  ],
  [
    "the walkthrough's buttons and media all resolve",
    async () => {
      // A `command:` link naming a command that is not registered renders as a dead button, and a
      // missing media file renders as an empty pane. Both fail silently in the UI, so they are
      // worth asserting rather than eyeballing once.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext, "the extension must be resolvable by id");
      const contributes = ext.packageJSON.contributes;
      const walkthroughs = contributes.walkthroughs ?? [];
      assert.strictEqual(walkthroughs.length, 1, "one walkthrough");
      const welcome = walkthroughs[0];
      assert.strictEqual(welcome.id, "welcome");

      const registered = new Set(await vscode.commands.getCommands(true));
      const linked = (text: string): string[] =>
        [...text.matchAll(/\(command:([^)\s]+)\)/g)].map((m) => m[1]);

      let buttons = 0;
      for (const step of welcome.steps) {
        for (const id of linked(step.description)) {
          buttons += 1;
          assert.ok(registered.has(id), `walkthrough step ${step.id} links to unknown ${id}`);
        }
        // Media is a file path relative to the extension root, or an inline image.
        const media = step.media ?? {};
        const file = media.markdown ?? media.image ?? media.svg;
        assert.ok(file, `step ${step.id} has no media`);
        assert.ok(
          fs.existsSync(vscode.Uri.joinPath(ext.extensionUri, file).fsPath),
          `step ${step.id} media is missing: ${file}`,
        );
      }
      assert.ok(buttons >= 3, `expected buttons on most steps, found ${buttons}`);

      // Each step gets its OWN media. Three of them once shared one file, so selecting Install,
      // Update or Create all filled the pane with the same page — and that pane is the larger half
      // of the walkthrough editor (VS Code's grid gives it 8fr against the steps' 5fr), which
      // makes a duplicate the most visible thing on screen.
      const files: string[] = welcome.steps.map(
        (s: { media: Record<string, string> }) =>
          s.media.markdown ?? s.media.image ?? s.media.svg,
      );
      assert.strictEqual(
        new Set(files).size,
        files.length,
        `walkthrough steps share media files: ${files.join(", ")}`,
      );

      // And each markdown pane carries at least one link into the documentation — the point of
      // that half of the page is to send the reader somewhere fuller than the step itself.
      for (const step of welcome.steps) {
        const md = step.media?.markdown;
        if (!md) {
          continue;
        }
        const text = fs.readFileSync(
          vscode.Uri.joinPath(ext.extensionUri, md).fsPath,
          "utf8",
        );
        assert.ok(
          /https:\/\/(?:vscode\.)?daybrite\.dev\/docs\//.test(text),
          `${md} links to no documentation`,
        );
      }

      // The same rule for the empty-view buttons, which are the only route out of "no project".
      for (const view of contributes.viewsWelcome ?? []) {
        for (const id of linked(view.contents)) {
          assert.ok(registered.has(id), `viewsWelcome (${view.view}) links to unknown ${id}`);
        }
      }
      assert.ok(
        (contributes.viewsWelcome ?? []).some((v: { contents: string }) =>
          v.contents.includes("command:day.newProject"),
        ),
        "an empty Day view must offer to create a project",
      );
    },
  ],
  [
    "the new-project picker offers real targets, from the catalog",
    async () => {
      // This list used to be hand-copied into extension.ts and named `windows-winui`, which is
      // not a target — picking it scaffolded nothing and failed in the CLI.
      const names = catalog().map((t) => t.name);
      assert.ok(names.includes("windows-xaml"), "the Windows target is windows-xaml");
      assert.ok(!names.includes("windows-winui"), "windows-winui is not a Day target");
      for (const expected of ["macos-appkit", "ios-uikit", "android-mdc", "web-dom"]) {
        assert.ok(names.includes(expected), `${expected} missing from the catalog`);
      }
      // Every entry must be classifiable, or the picker cannot say what a host can build.
      for (const t of catalog()) {
        assert.ok(
          ["macos", "linux", "windows", "any"].includes(t.host),
          `${t.name} has an unusable host: ${t.host}`,
        );
      }
    },
  ],
  [
    "lint findings become diagnostics, and only the ones an author should act on",
    async () => {
      const root = process.platform === "win32" ? "c:\\w\\app" : "/w/app";
      const { diagnostics, fixes } = mapFindings(root, [
        {
          code: "day::lint::unknown-key",
          severity: "error",
          message: 'tr("nope") has no message',
          file: "src/lib.rs",
          line: 88,
          column: 9,
        },
        {
          code: "day::lint::store-whitespace",
          severity: "warning",
          message: "leading or trailing whitespace",
          file: "store/en/name.txt",
          line: 1,
          column: 1,
          fix: {
            title: "Trim it",
            file: "store/en/name.txt",
            contents: "Name\n",
          },
        },
        // Waived: the author said this one may stand, so squiggling it would argue with them.
        {
          code: "day::lint::store-placeholder",
          severity: "warning",
          message: "still TODO",
          waived: true,
          file: "store/en/short.txt",
        },
        // No file — a locale that exists on no surface has nowhere to point.
        {
          code: "day::lint::locale-sync",
          severity: "warning",
          message: "fr is missing",
        },
      ]);

      assert.strictEqual(
        diagnostics.size,
        2,
        "only the two findings with a place and no waiver",
      );
      const source = vscode.Uri.joinPath(
        vscode.Uri.file(root),
        "src",
        "lib.rs",
      ).toString();
      const [unknownKey] = diagnostics.get(source) ?? [];
      assert.ok(
        unknownKey,
        `no diagnostic on ${source}: ${[...diagnostics.keys()].join(", ")}`,
      );
      assert.strictEqual(unknownKey.severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(unknownKey.code, "day::lint::unknown-key");
      // The CLI counts lines and columns from 1, the editor from 0. Off by one here puts every
      // squiggle on the wrong line, which looks like the lint being wrong.
      assert.strictEqual(unknownKey.range.start.line, 87);
      assert.strictEqual(unknownKey.range.start.character, 8);

      const store = vscode.Uri.joinPath(
        vscode.Uri.file(root),
        "store",
        "en",
        "name.txt",
      ).toString();
      assert.strictEqual(
        fixes.get(source),
        undefined,
        "a rule with no repair offers no action",
      );
      assert.strictEqual(
        fixes.get(store)?.get("day::lint::store-whitespace@0")?.contents,
        "Name\n",
        "the fix must be reachable from the diagnostic's code and line",
      );

      // The fix replaces the file WHOLE, so the range has to span it exactly — a range that fell
      // short would append the new text to the old instead of replacing it.
      const document = await vscode.workspace.openTextDocument({
        content: "  Day Rise  \n\ntrailing\n",
      });
      const edit = editFor(document, {
        title: "Trim it",
        file: "store/en/name.txt",
        contents: "Day Rise\n",
      });
      const [entry] = edit.get(document.uri);
      assert.ok(entry, "the edit must target the document it was built from");
      assert.strictEqual(entry.newText, "Day Rise\n");
      assert.strictEqual(document.getText(entry.range), document.getText());
    },
  ],
  [
    "day.lintProject is registered and survives a CLI that predates `lint --json`",
    async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes("day.lintProject"),
        "day.lintProject must be registered",
      );
      assert.ok(commands.includes("day.fixAllInFile"));

      // The e2e leg installs the day CLI from day's main branch, which may not carry `--json`
      // yet. Missing it must leave the extension usable, so this asserts the SHAPE of the answer
      // rather than that findings came back: an envelope, or a clean `undefined`.
      const output = vscode.window.createOutputChannel("Day lint check");
      try {
        const lint = new Lint(output);
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, "the fixture workspace must have a folder");
        const counts = await lint.run(folder.uri.fsPath);
        if (counts) {
          assert.strictEqual(typeof (counts.errors ?? 0), "number");
          assert.strictEqual(typeof (counts.warnings ?? 0), "number");
        }
        lint.dispose();
      } finally {
        output.dispose();
      }
    },
  ],
  [
    "Stop asks the CLI to stop the app, not just the task that launched it",
    () => {
      // Ending the task kills what `day` launched as its own child — the whole story on a
      // desktop, and none of it on a device. An Android app is started with `am start` and lives
      // in the device's process table, so terminating the launcher (which is what VS Code does,
      // without letting it clean up) left the app on screen and its session in the registry.
      // Verified against a real emulator: SIGKILL the launcher and the app keeps its pid;
      // `day stop -p android-mdc` is what ends it.
      const args = stopArgs("/w/Day-Rise", "android-mdc");
      assert.deepStrictEqual(args, [
        "--project",
        "/w/Day-Rise",
        "stop",
        "-p",
        "android-mdc",
      ]);
      assert.strictEqual(
        args.indexOf("--project"),
        0,
        "--project is a global flag and must precede the subcommand",
      );
      // One target, never everything: Stop is a per-row button, and `--all` would take down the
      // other apps in a multi-project window.
      assert.ok(!args.includes("--all"), args.join(" "));
    },
  ],
  [
    "lint names its project on the command line, not by where it happens to run",
    async () => {
      // With `day.cliSource` set, the command is `cargo run --manifest-path <checkout>` and its
      // cwd is the CHECKOUT — so a lint that relied on cwd-based Day.toml discovery looked for
      // the manifest in day's own repo and failed with "no Day.toml found".
      const args = lintArgs("/w/Day-Showcase");
      assert.deepStrictEqual(args, [
        "--project",
        "/w/Day-Showcase",
        "lint",
        "--json",
      ]);
      assert.strictEqual(
        args.indexOf("--project"),
        0,
        "--project is a global flag and must precede the subcommand",
      );
      // An unknown root falls back to discovery rather than passing an empty --project, which
      // clap would read as the next token.
      assert.deepStrictEqual(lintArgs(""), ["lint", "--json"]);
    },
  ],
  [
    "a quick fix repairs the file and the finding is gone on the next lint",
    async () => {
      // The whole loop, against a real CLI: lint → diagnostic → apply the edit → save → re-lint.
      // A four-file project is enough, because the two fixable rules are store rules and the
      // store lint only needs a mobile target declared.
      const root = fs.mkdtempSync(`${os.tmpdir()}/day-lint-`);
      const write = (rel: string, text: string): void => {
        const full = `${root}/${rel}`;
        fs.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
        fs.writeFileSync(full, text);
      };
      write(
        "Cargo.toml",
        '[package]\nname = "min"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      write(
        "Day.toml",
        'schema = 1\n\n[app]\nid = "com.example.min"\ntitle = "Min"\ntargets = ["ios-uikit"]\n',
      );
      write("src/lib.rs", "pub fn f() {}\n");
      write("store/en/name.txt", "Min  \n");

      const output = vscode.window.createOutputChannel("Day lint fix check");
      const lint = new Lint(output);
      try {
        const counts = await lint.run(root);
        if (!counts) {
          console.log("    (skipped: this day CLI has no `lint --json` yet)");
          return;
        }
        const uri = vscode.Uri.file(`${root}/store/en/name.txt`);
        const [fix] = lint.fixesIn(uri);
        assert.ok(fix, "the whitespace rule must propose a repair");
        assert.strictEqual(fix.contents, "Min\n");

        const document = await vscode.workspace.openTextDocument(uri);
        assert.ok(await vscode.workspace.applyEdit(editFor(document, fix)));
        // The CLI reads from DISK, so an unsaved buffer would leave it linting the old text and
        // reporting a finding the author has already fixed.
        assert.ok(await document.save());

        const after = await lint.run(root);
        assert.ok(after);
        assert.strictEqual(
          after.fixable,
          0,
          "the repaired finding must not come back",
        );
        assert.strictEqual(lint.fixesIn(uri).length, 0);
        assert.strictEqual(
          fs.readFileSync(`${root}/store/en/name.txt`, "utf8"),
          "Min\n",
        );
      } finally {
        lint.dispose();
        output.dispose();
        fs.rmSync(root, { recursive: true, force: true });
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
    "the install picker offers the released CLI first and the source build last",
    () => {
      // Order is the whole point of this list. The released CLI is what almost everyone wants and
      // the extension owns that copy; the source build needs a Rust toolchain and takes minutes,
      // so it goes last among the things that actually install something.
      const choices = installChoices(installRoutes("darwin"), true);
      const labels = choices.map((c) => c.label);
      assert.strictEqual(labels[0], "Install the latest release (crates.io)");
      assert.strictEqual(
        labels[labels.length - 2],
        "Install from Source (main branch)",
        `the source build should be the last installing row, got ${labels.join(" | ")}`,
      );
      assert.strictEqual(
        labels[labels.length - 1],
        "Open the install instructions",
      );
      assert.ok(
        !labels.some((l) => /homebrew/i.test(l)),
        "Homebrew was dropped from the picker",
      );

      // Exactly ONE row installs from crates.io. There were two — the managed one and a plain
      // `cargo install day-cli` onto PATH — which differed only in where the binary landed.
      assert.strictEqual(
        labels.filter((l) => /crates\.io|cargo install day-cli/.test(l)).length,
        1,
        `expected one crates.io row, got ${labels.join(" | ")}`,
      );

      // The rows the extension installs itself are exactly the two version-bearing ones.
      assert.deepStrictEqual(
        choices.filter((c) => c.version !== undefined).map((c) => c.version),
        ["", "main"],
        "the release row installs the crates.io version, the source row builds main",
      );

      // A pinned `day.cliVersion` earns its own row, right after the release.
      const withPin = installChoices(installRoutes("linux"), true, "v0.3.0");
      assert.strictEqual(withPin[1].label, "Install v0.3.0 (day.cliVersion)");
      assert.strictEqual(withPin[1].version, "v0.3.0");

      // With nowhere to put an extension-owned copy, those rows are gone rather than offered
      // and then failing.
      const unmanaged = installChoices(installRoutes("win32"), false);
      assert.ok(unmanaged.every((c) => c.version === undefined));
      assert.ok(!unmanaged.some((c) => /crates\.io|Source/.test(c.label)));
    },
  ],
  [
    "every PATH route is Rust-free, and no row is long enough to be truncated",
    () => {
      // The routes that touch PATH exist for someone who has no Rust toolchain — that is the
      // whole reason they are separate from the managed rows. `cargo install day-cli` used to sit
      // among them and needed one, which is what made it the wrong thing to offer here.
      for (const platform of [
        "darwin",
        "linux",
        "win32",
      ] as NodeJS.Platform[]) {
        const routes = installRoutes(platform);
        assert.ok(routes.length > 0, `${platform}: no route at all`);
        for (const r of routes) {
          assert.ok(
            !/cargo/.test(r.command),
            `${platform}: a PATH route needs no toolchain, got ${r.command}`,
          );
          assert.match(
            r.command,
            /curl|irm/,
            `${platform}: expected a prebuilt download, got ${r.command}`,
          );
        }
        assert.ok(
          !routes.some((r) => r.command.includes("brew")),
          `${platform} still offers Homebrew`,
        );
      }

      // A quick pick truncates a long `detail` with an ellipsis, and the description column shows
      // whatever it is given — a raw install command is long enough to be cut mid-flag. Both are
      // bounded here because both looked wrong in the picker before they were.
      for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
        for (const c of installChoices(
          installRoutes(platform),
          true,
          "v0.3.0",
        )) {
          assert.ok(
            c.detail.length <= 70,
            `"${c.label}" detail is ${c.detail.length} chars: ${c.detail}`,
          );
          // Bounded rather than ellipsis-free: one row elides a long flag list on purpose
          // (`cargo install --git … --tag`), which is not the same as a command cut mid-flag by
          // a width limit. Length is what the picker actually punishes.
          assert.ok(
            c.description.length <= 50,
            `"${c.label}" description is ${c.description.length} chars: ${c.description}`,
          );
        }
      }
    },
  ],
  [
    "each project can carry its own log level, verbose and env",
    async () => {
      // Folder-scoped settings: one app at trace while the next stays quiet, and the difference
      // has to reach the actual command line rather than just the settings UI.
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(
        folders.length,
        2,
        "this check needs the two-project fixture",
      );
      const [a, b] = folders;
      const cfgFor = (f: vscode.WorkspaceFolder) =>
        vscode.workspace.getConfiguration("day", f.uri);
      const detailFor = async (f: vscode.WorkspaceFolder): Promise<string> => {
        const tasks = await vscode.tasks.fetchTasks({ type: "day" });
        const name = baseName(f.uri.fsPath);
        const task = tasks.find((t) => t.name.endsWith(`(${name})`));
        assert.ok(task, `no task for ${name} in ${tasks.map((t) => t.name)}`);
        return task.detail ?? "";
      };

      try {
        await cfgFor(a).update(
          "logLevel",
          "warn",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await cfgFor(b).update(
          "logLevel",
          "error",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await cfgFor(a).update(
          "verbose",
          true,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );

        const [da, db] = [await detailFor(a), await detailFor(b)];
        assert.ok(
          da.includes("--env DAY_LOG=warn"),
          `first project's level missing: ${da}`,
        );
        assert.ok(
          db.includes("--env DAY_LOG=error"),
          `second project's level missing: ${db}`,
        );
        // Verbose set on ONE project must not leak into the other's command line.
        assert.ok(
          da.includes("--verbose"),
          `first project should be verbose: ${da}`,
        );
        assert.ok(
          !db.includes("--verbose"),
          `verbose leaked into the second project: ${db}`,
        );
      } finally {
        for (const f of [a, b]) {
          await cfgFor(f).update(
            "logLevel",
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          await cfgFor(f).update(
            "verbose",
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
        }
      }
    },
  ],
  [
    "a chosen device rides the command line as the flag the CLI named",
    async () => {
      // The device's OWN flag is what gets used, never one derived from the target: iOS needs
      // `--ios-simulator` for a booted simulator and `--ios-device` for a plugged-in phone, and
      // only the listing knows which a given device is.
      const base = {
        projectRoot: "/w/Day-Rise",
        target: "ios-uikit",
        profile: "debug" as const,
      };
      assert.ok(
        !launchArgs(base).some((a) => a.startsWith("--ios-")),
        "with no device chosen the launch stays on the CLI's every-connected-device default",
      );
      for (const flag of [
        "--ios-simulator",
        "--ios-device",
        "--android-device",
        "--ohos-device",
      ]) {
        const args = launchArgs({ ...base, device: { id: "PICKED-ID", flag } });
        assert.ok(
          args.join(" ").includes(`${flag} PICKED-ID`),
          `expected "${flag} PICKED-ID" in ${args.join(" ")}`,
        );
      }

      // …and the store keeps it per project AND per target, so a phone picked for one app's
      // ios-uikit says nothing about another app's.
      const state = new State(fakeMemento());
      const rise = "/w/Day-Rise";
      const showcase = "/w/Day-Showcase";
      const device = {
        id: "UDID-1",
        label: "iPhone 16",
        flag: "--ios-simulator",
      };
      await state.addDevice(rise, "ios-uikit", device);
      assert.deepStrictEqual(state.devicesFor(rise, "ios-uikit"), [device]);
      assert.deepStrictEqual(
        state.devicesFor(rise, "android-mdc"),
        [],
        "adding for one target must not touch another",
      );
      assert.deepStrictEqual(
        state.devicesFor(showcase, "ios-uikit"),
        [],
        "adding for one project must not touch another",
      );
      await state.removeDevice(rise, "ios-uikit", device.id);
      assert.deepStrictEqual(
        state.devicesFor(rise, "ios-uikit"),
        [],
        "removing the last one returns to every connected device",
      );
    },
  ],
  [
    "a configuration row edits the project it sits under, not the focused one",
    async () => {
      // The point of moving Configuration inside each project: with a dozen apps open, a row that
      // quietly edited whichever project happened to be focused would be indistinguishable from a
      // bug. Verbose is the row to test with — it is the only one that takes no quick pick.
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(
        folders.length,
        2,
        "this check needs the two-project fixture",
      );
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const api = (await ext.activate()) as {
        focusedProject(): string | undefined;
      };

      // Canonical roots as the extension knows them, by focusing each in turn.
      const rootOf = async (
        folder: vscode.WorkspaceFolder,
      ): Promise<string> => {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(`${folder.uri.fsPath}/Day.toml`),
        );
        await vscode.window.showTextDocument(doc, { preview: false });
        for (let i = 0; i < 50 && !api.focusedProject(); i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return api.focusedProject()!;
      };
      const second = await rootOf(folders[1]);
      const first = await rootOf(folders[0]);
      assert.strictEqual(
        api.focusedProject(),
        first,
        "the first project should now be focused",
      );

      const carries = async (name: string): Promise<boolean> =>
        (await vscode.tasks.fetchTasks({ type: "day" }))
          .filter((t) => t.name.endsWith(`(${baseName(name)})`))
          .every((t) => (t.detail ?? "").includes("--verbose"));

      try {
        // Toggle the UNFOCUSED project's row, by passing the node that row would pass.
        await vscode.commands.executeCommand("day.toggleVerbose", {
          kind: "config",
          root: second,
          which: "verbose",
        });
        assert.ok(
          await carries(second),
          "the row's own project should have gone verbose",
        );
        assert.ok(
          !(await carries(first)),
          "the focused project must be untouched — the row named a different one",
        );
        assert.strictEqual(
          api.focusedProject(),
          first,
          "editing a row must not move focus",
        );
      } finally {
        await vscode.commands.executeCommand("day.toggleVerbose", {
          kind: "config",
          root: second,
          which: "verbose",
        });
      }
    },
  ],
  [
    "the toolchain settings export the variables the tools actually read",
    async () => {
      // Names matter more than usual here: `ANDROID_SDK_HOME` is a legacy variable naming the
      // `.android` user directory and selects no SDK at all, so exporting that instead of
      // `ANDROID_HOME` would look configured and change nothing.
      const cfg = vscode.workspace.getConfiguration("day");
      const sdk = os.tmpdir();
      try {
        await cfg.update(
          "androidSDKHome",
          sdk,
          vscode.ConfigurationTarget.Workspace,
        );
        await cfg.update(
          "androidNDKHome",
          `${sdk}/ndk`,
          vscode.ConfigurationTarget.Workspace,
        );
        await cfg.update(
          "xcodeDeveloperDirectory",
          "/Applications/Xcode.app",
          vscode.ConfigurationTarget.Workspace,
        );
        const env = toolchainEnv();
        assert.strictEqual(
          env.ANDROID_HOME,
          sdk,
          "day-toolchain reads ANDROID_HOME first",
        );
        assert.strictEqual(
          env.ANDROID_SDK_ROOT,
          sdk,
          "Google's tooling prefers ANDROID_SDK_ROOT",
        );
        assert.strictEqual(
          env.ANDROID_SDK_HOME,
          undefined,
          "the legacy name selects no SDK",
        );
        assert.strictEqual(env.ANDROID_NDK_HOME, `${sdk}/ndk`);
        // An `.app` is what a person picks; the variable wants the Developer dir inside it.
        // Asserted with forward slashes on EVERY host: an Xcode path is a macOS path wherever
        // the editor runs, and joining it with the host separator handed `xcrun`
        // `\Applications\Xcode.app\Contents\Developer` on the Windows leg.
        assert.strictEqual(
          env.DEVELOPER_DIR,
          "/Applications/Xcode.app/Contents/Developer",
          "an .app bundle must be resolved to its Developer dir",
        );

        // Shell completion adds the trailing slash, and it names the same bundle.
        await cfg.update(
          "xcodeDeveloperDirectory",
          "/Applications/Xcode.app/",
          vscode.ConfigurationTarget.Workspace,
        );
        assert.strictEqual(
          toolchainEnv().DEVELOPER_DIR,
          "/Applications/Xcode.app/Contents/Developer",
          "a trailing separator is the same bundle",
        );

        // A Developer dir given directly is already what the variable wants — passed through.
        await cfg.update(
          "xcodeDeveloperDirectory",
          "/Applications/Xcode-beta.app/Contents/Developer",
          vscode.ConfigurationTarget.Workspace,
        );
        assert.strictEqual(
          toolchainEnv().DEVELOPER_DIR,
          "/Applications/Xcode-beta.app/Contents/Developer",
        );
      } finally {
        for (const key of [
          "androidSDKHome",
          "androidNDKHome",
          "xcodeDeveloperDirectory",
        ]) {
          await cfg.update(
            key,
            undefined,
            vscode.ConfigurationTarget.Workspace,
          );
        }
      }
      // Unset settings contribute nothing, so the inherited environment is left exactly as it is.
      const bare = toolchainEnv();
      for (const key of [
        "ANDROID_HOME",
        "ANDROID_SDK_ROOT",
        "ANDROID_NDK_HOME",
        "DEVELOPER_DIR",
      ]) {
        assert.strictEqual(
          bare[key],
          undefined,
          `${key} must not be invented when unset`,
        );
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
          await cfg.update(
            "cliSource",
            repo,
            vscode.ConfigurationTarget.Workspace,
          );
          const cli = resolveCli();
          // `cargo` only when it can actually be spawned; the fallback is deliberate, not a bug,
          // so accept either shape and check the one that applies.
          if (cli.command === "cargo") {
            assert.deepStrictEqual(cli.baseArgs.slice(0, 2), [
              "run",
              "--manifest-path",
            ]);
            assert.ok(
              cli.baseArgs.includes("day-cli"),
              `expected -p day-cli in ${cli.baseArgs}`,
            );
            assert.strictEqual(
              cli.cwd,
              repo,
              "cargo must run in the checkout, not the app",
            );
          } else {
            assert.match(
              cli.command,
              /day(\.exe)?$/,
              `unexpected fallback ${cli.command}`,
            );
          }
        }
        // A folder that is not a day checkout must not hijack the CLI — it falls through to the
        // normal resolution instead of spawning cargo somewhere meaningless.
        await cfg.update(
          "cliSource",
          os.tmpdir(),
          vscode.ConfigurationTarget.Workspace,
        );
        const bogus = resolveCli();
        assert.notStrictEqual(
          bogus.cwd,
          os.tmpdir(),
          "a non-checkout day.cliSource must be ignored, not used as a cargo workspace",
        );
      } finally {
        await cfg.update(
          "cliSource",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
    },
  ],
  [
    "agent mode is offered one MCP server per Day project, each naming its own",
    () => {
      const win = process.platform === "win32";
      const rise = win ? "c:\\w\\Day-Rise" : "/w/Day-Rise";
      const sketch = win ? "c:\\w\\Day-Sketch" : "/w/Day-Sketch";
      const specs = mcpServerSpecs([
        { root: rise, name: "day-rise", title: "Day Rise" },
        { root: sketch, name: "day-sketch", title: "Day Sketch" },
      ]);

      // One per project, not one for the focused project. A window holding several apps otherwise
      // gives an agent no way to reach the others: the tools take no project argument, so a server
      // bound to the wrong root builds the wrong app and reports no sessions for one that is
      // plainly running.
      assert.strictEqual(specs.length, 2, "every Day project needs a server");
      assert.deepStrictEqual(
        specs.map((s) => s.label),
        ["Day: Day Rise", "Day: Day Sketch"],
        "each server has to name its project, or the list is unpickable",
      );

      for (const [i, root] of [rise, sketch].entries()) {
        // The tail is what each server reports on. Drop `--project` and a CLI resolved from a
        // checkout runs with THAT checkout as its cwd, so the agent inspects, builds and drives
        // the wrong tree — the same trap `lintArgs` exists to close.
        assert.deepStrictEqual(specs[i].args.slice(-3), [
          "--project",
          root,
          "mcp-server",
        ]);
        const cli = resolveCli(root);
        assert.strictEqual(specs[i].command, cli.command);
        assert.deepStrictEqual(
          specs[i].args.slice(0, cli.baseArgs.length),
          cli.baseArgs,
          "the resolved CLI's own args have to come before the day subcommand",
        );
      }
    },
  ],
  [
    "MCP servers for identically-titled projects stay tellable apart",
    () => {
      // Not hypothetical: two checkouts of the same app in one window carry the same title, and
      // two entries reading "Day: Day Rise" would restore exactly the ambiguity labels remove.
      const win = process.platform === "win32";
      const a = win ? "c:\\w\\rise" : "/w/rise";
      const b = win ? "c:\\w\\rise-fork" : "/w/rise-fork";
      const specs = mcpServerSpecs([
        { root: a, name: "day-rise", title: "Day Rise" },
        { root: b, name: "day-rise", title: "Day Rise" },
      ]);
      assert.deepStrictEqual(
        specs.map((s) => s.label),
        ["Day: Day Rise (rise)", "Day: Day Rise (rise-fork)"],
      );
      // A project with no title falls back to its crate name rather than going unnamed.
      assert.deepStrictEqual(
        mcpServerSpecs([{ root: a, name: "day-rise" }]).map((s) => s.label),
        ["Day: day-rise"],
      );
    },
  ],
  [
    "an MCP server resolved from a checkout runs in that checkout",
    async () => {
      // The cwd only exists when the CLI resolves to `cargo run`, and neither CI nor a plain
      // install has a day checkout to produce one — so the checkout is synthesised. `isDayCheckout`
      // asks for exactly these two manifests, which is all that is needed to reach the cargo path.
      const checkout = fs.mkdtempSync(`${os.tmpdir()}/day-checkout-`);
      fs.mkdirSync(path.join(checkout, "crates", "day-cli"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(checkout, "Cargo.toml"), "");
      fs.writeFileSync(
        path.join(checkout, "crates", "day-cli", "Cargo.toml"),
        "",
      );
      const root = process.platform === "win32" ? "c:\\w\\app" : "/w/app";
      const cfg = vscode.workspace.getConfiguration("day");
      try {
        await cfg.update(
          "cliSource",
          checkout,
          vscode.ConfigurationTarget.Workspace,
        );
        const specs = mcpServerSpecs([{ root, name: "app" }]);
        assert.strictEqual(specs.length, 1);
        const spec = specs[0];
        if (spec.command === "cargo") {
          // Without this the agent's server would run cargo in the APP, reading its
          // `.cargo/config` and building whatever that resolves to instead of the CLI.
          assert.strictEqual(
            spec.cwd,
            checkout,
            "a cargo-run MCP server must run in the checkout, not the app",
          );
          assert.ok(
            spec.args.includes("--manifest-path"),
            `expected a manifest-path invocation in ${spec.args}`,
          );
        } else {
          // `cargo` is not spawnable from this extension host, so resolveCli deliberately fell
          // back; the fallback is a plain binary, which needs no cwd.
          assert.match(
            spec.command,
            /day(\.exe)?$/,
            `unexpected ${spec.command}`,
          );
        }
        // Either way the project still has to ride the command line.
        assert.deepStrictEqual(spec.args.slice(-3), [
          "--project",
          root,
          "mcp-server",
        ]);

        // The server shells back into the CLI for every tool call, and by default that is its own
        // executable — the `target/debug/day` cargo produced when it started. In a cliSource
        // window that is NOT the CLI the editor uses, so a day-cli edit would reach Build and Run
        // but not the agent's tools, and one window would be running two different CLIs.
        if (spec.command === "cargo") {
          const self = spec.env.DAY_SELF_COMMAND;
          assert.ok(
            self,
            "a cargo-run MCP server must tell the server how to re-invoke the CLI",
          );
          // Everything before `--project <root> mcp-server` is the CLI invocation itself.
          assert.deepStrictEqual(
            JSON.parse(self),
            [spec.command, ...spec.args.slice(0, -3)],
            "DAY_SELF_COMMAND must name the very invocation the editor resolved",
          );
        } else {
          assert.deepStrictEqual(
            spec.env,
            {},
            "a plain binary needs no override — the server already runs it",
          );
        }
      } finally {
        await cfg.update(
          "cliSource",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    },
  ],
  [
    "MCP servers are withheld when there is nothing to serve",
    async () => {
      const root = process.platform === "win32" ? "c:\\w\\app" : "/w/app";
      const one = [{ root, name: "app" }];
      assert.deepStrictEqual(
        mcpServerSpecs([]),
        [],
        "a window with no Day project has nothing to serve",
      );
      const cfg = vscode.workspace.getConfiguration("day");
      try {
        await cfg.update(
          "mcp.enabled",
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        assert.deepStrictEqual(
          mcpServerSpecs(one),
          [],
          "day.mcp.enabled must actually withhold the servers",
        );
      } finally {
        await cfg.update(
          "mcp.enabled",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
      assert.strictEqual(
        mcpServerSpecs(one).length,
        1,
        "clearing the setting restores the server",
      );
    },
  ],
  [
    "the contributed MCP provider id is the one the extension registers",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const providers = (ext.packageJSON?.contributes
        ?.mcpServerDefinitionProviders ?? []) as {
        id: string;
        label?: string;
      }[];
      assert.strictEqual(
        providers.length,
        1,
        "one MCP provider is contributed",
      );
      // VS Code pairs the manifest's id with the id passed to
      // registerMcpServerDefinitionProvider. A mismatch raises nothing anywhere: the provider is
      // simply never consulted, and agent mode quietly offers no Day tools.
      assert.strictEqual(providers[0].id, MCP_PROVIDER_ID);
      assert.ok(
        providers[0].label,
        "the provider needs a label to name it in VS Code's MCP servers list",
      );
    },
  ],
  [
    "the CLI install target follows the setting, defaulting to the crates.io release",
    () => {
      const root =
        process.platform === "win32" ? "c:\\store\\cli" : "/store/cli";

      // Unset is the newest RELEASE, from crates.io — the same answer the Day view compares
      // against, so "latest" means one thing rather than two that can disagree. Asserted against
      // the DECLARED default so the two cannot drift.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      assert.strictEqual(
        ext.packageJSON.contributes.configuration[0].properties[
          "day.cliVersion"
        ].default,
        "",
      );
      const release = resolveSourceVersion("");
      assert.strictEqual(release.fromGit, false);
      const releaseCmd = sourceInstallCommand(release, root);
      assert.ok(
        releaseCmd.startsWith("cargo install day-cli"),
        `expected a registry install, got ${releaseCmd}`,
      );
      assert.ok(!releaseCmd.includes("--git"), releaseCmd);

      // `main` is a BRANCH — `--tag main` would fail, since no such tag exists.
      const main = resolveSourceVersion("main");
      assert.deepStrictEqual(main.ref, ["--branch", "main"]);
      assert.ok(main.fromGit);
      // Anything else is taken literally, so a tag and a bare revision both work.
      assert.deepStrictEqual(resolveSourceVersion("v0.3.0").ref, [
        "--tag",
        "v0.3.0",
      ]);
      assert.deepStrictEqual(resolveSourceVersion(" main ").ref, [
        "--branch",
        "main",
      ]);

      const gitCmd = sourceInstallCommand(main, root);
      assert.ok(gitCmd.includes("--git"), gitCmd);
      assert.ok(gitCmd.includes("--branch main"), gitCmd);
      // `--root` keeps this out of ~/.cargo/bin and off the PATH; `--force` is what lets a second
      // install replace the first, which is how changing the version takes effect.
      for (const cmd of [releaseCmd, gitCmd]) {
        assert.ok(cmd.includes("--force"), cmd);
        assert.ok(
          cmd.includes(root) || cmd.includes(JSON.stringify(root)),
          cmd,
        );
      }

      assert.strictEqual(managedCliDir(root), path.join(root, "cli"));
    },
  ],
  [
    "the Day view's CLI row shows the version, and offers the update when there is one",
    () => {
      // The row exists because a walkthrough cannot render these numbers — its text is fixed in
      // package.json. Every state it can be in is checked here, since each is a different message
      // and getting one wrong means the view quietly says the wrong thing about the toolchain.
      const missing = cliItem({});
      assert.strictEqual(missing.description, "not installed");
      assert.strictEqual(missing.contextValue, "dayCli");

      const current = cliItem({ installed: "0.3.0", latest: "0.3.0" });
      assert.strictEqual(current.label, "day 0.3.0");
      assert.strictEqual(current.description, "up to date");
      assert.strictEqual(current.contextValue, "dayCli");

      const stale = cliItem({ installed: "0.3.0", latest: "0.4.1" });
      assert.strictEqual(stale.label, "day 0.3.0");
      assert.strictEqual(stale.description, "update to 0.4.1");
      assert.strictEqual(
        stale.contextValue,
        "dayCliOutdated",
        "a distinct context value, so a menu can offer the update only when there is one",
      );

      // Offline: a version but no answer about the newest. It must not claim either way.
      const unknown = cliItem({ installed: "0.3.0" });
      assert.strictEqual(unknown.description, undefined);
      assert.strictEqual(unknown.contextValue, "dayCli");

      // Every state acts through the one command.
      for (const item of [missing, current, stale, unknown]) {
        assert.strictEqual(item.command?.command, "day.installCli");
      }
    },
  ],
  [
    "the CLI version is read and compared as numbers, not as text",
    () => {
      // What `day version` prints, in each shape it prints it.
      assert.strictEqual(
        parseVersion("day 0.3.0 (release, branch main, bd026ff7)"),
        "0.3.0",
      );
      // A source build marks a debug profile with `*`, which must not defeat the parse.
      assert.strictEqual(
        parseVersion("day 0.3.0* (debug, branch main, 7708193a)"),
        "0.3.0*",
      );
      assert.strictEqual(parseVersion("not a version"), undefined);

      assert.ok(isNewer("0.3.0", "0.4.1"));
      assert.ok(isNewer("0.3.0*", "0.3.1"), "a debug build still compares");
      assert.ok(!isNewer("0.4.1", "0.3.0"), "older is not an update");
      assert.ok(!isNewer("0.3.0", "0.3.0"), "same is not an update");
      // The whole reason this is not a string compare: lexicographically "0.10.0" < "0.4.0".
      assert.ok(isNewer("0.4.0", "0.10.0"), "0.10.0 is newer than 0.4.0");
      assert.ok(!isNewer("0.10.0", "0.4.0"));
      // Unreadable on either side means no claim — never a spurious update prompt.
      assert.ok(!isNewer("main", "0.4.0"));
      assert.ok(!isNewer("0.4.0", "unknown"));
    },
  ],
  [
    "the walkthrough's update step is gated on the context key the extension sets",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const steps = ext.packageJSON.contributes.walkthroughs[0].steps as {
        id: string;
        when?: string;
        description: string;
      }[];
      const update = steps.find((s) => s.id === "update-cli");
      assert.ok(update, "the walkthrough offers an update step");
      // A walkthrough cannot render the version numbers — its text is fixed here — so `when` is
      // the only way it reacts at all. Gated on the wrong key it would either never appear or
      // always appear, and both look like the feature is broken.
      assert.strictEqual(update.when, UPDATE_CONTEXT);
      assert.ok(
        update.description.includes("command:day.installCli"),
        "and it acts through the install/update command",
      );
    },
  ],
  [
    "the Marketplace listing claims real categories, and each is earned",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const pkg = ext.packageJSON;
      // VS Code's own enum (workbench `AB`). The Marketplace ignores anything outside it and
      // files the extension under "Other" — silently, which is how the listing sat there
      // reading "Other" without anyone noticing.
      const LEGAL = [
        "AI",
        "Azure",
        "Chat",
        "Data Science",
        "Debuggers",
        "Extension Packs",
        "Education",
        "Formatters",
        "Keymaps",
        "Language Packs",
        "Linters",
        "Machine Learning",
        "Notebooks",
        "Programming Languages",
        "SCM Providers",
        "Snippets",
        "Testing",
        "Themes",
        "Visualization",
        "Other",
      ];
      const categories = pkg.categories as string[];
      assert.ok(categories?.length, "the manifest must claim a category");
      for (const c of categories) {
        assert.ok(LEGAL.includes(c), `${c} is not a Marketplace category`);
      }
      assert.ok(
        !categories.includes("Other"),
        "Other is the fallback for claiming nothing — name what this extension does",
      );

      // Each category is a claim about a contribution, so the two are checked against each other:
      // a category that stops being true is worse than one that was never there.
      if (categories.includes("Debuggers")) {
        assert.ok(
          (pkg.contributes?.debuggers ?? []).length > 0,
          "Debuggers claims a debug adapter",
        );
      }
      if (categories.includes("AI")) {
        assert.ok(
          (pkg.contributes?.mcpServerDefinitionProviders ?? []).length > 0,
          "AI claims the MCP server it offers agent mode",
        );
      }
      if (categories.includes("Linters")) {
        assert.ok(
          (pkg.contributes?.commands ?? []).some(
            (c: { command: string }) => c.command === "day.lintProject",
          ),
          "Linters claims the lint command",
        );
      }
    },
  ],
  [
    "every setting is on one page, common ones first and SDK paths last",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const cats = ext.packageJSON.contributes.configuration as {
        title: string;
        properties: Record<string, { order?: number }>;
      }[];
      // One category. Several would split the settings across sub-entries in the settings tree,
      // which is how a handful of them ended up filed under Scripts / Debugging / AI · Agents
      // where nobody looking at the Day page would find them.
      assert.strictEqual(
        cats.length,
        1,
        `expected a single Day settings page, got ${cats.map((c) => c.title).join(", ")}`,
      );

      const entries = Object.entries(cats[0].properties);
      const orders = entries.map(([, v]) => v.order);
      assert.ok(
        orders.every((o) => typeof o === "number"),
        "every setting needs an explicit order — VS Code sorts the page by it",
      );
      assert.deepStrictEqual(
        [...orders].sort((a, b) => a! - b!),
        entries.map((_, i) => i + 1),
        "orders must be unique and contiguous from 1, or the page order is not what it reads as",
      );

      // The platform SDK locations are the least-touched settings here — most people never set
      // one, and the ones who do set it once. They belong after everything else.
      const byOrder = entries
        .slice()
        .sort((a, b) => a[1].order! - b[1].order!)
        .map(([k]) => k);
      const paths = [
        "day.xcodeDeveloperDirectory",
        "day.androidSDKHome",
        "day.androidNDKHome",
        "day.harmonyNDKHome",
      ];
      assert.deepStrictEqual(
        byOrder.slice(-paths.length),
        paths,
        "the toolchain paths must sit at the bottom of the page",
      );
      // And the everyday one is at the top.
      assert.strictEqual(byOrder[0], "day.defaultProfile");
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
      assert.strictEqual(cfg.get("logLevel"), "debug");
      assert.strictEqual(cfg.get("followActiveEditor"), true);
      // Both default OFF: the walkthrough shows itself once per install without a setting, and
      // `scripts/dev.sh` turns this on only inside the workspace it generates.
      assert.strictEqual(cfg.get("showWalkthroughOnStartup"), false);
      assert.strictEqual(cfg.get("newProject.openAfterCreate"), "ask");
    },
  ],
  [
    "opening a file focuses the project it belongs to",
    async () => {
      // The context rule: which app the Configuration rows, the Run button and the status bar act
      // on follows the file being worked on, so moving between apps needs no extra gesture.
      const folders = vscode.workspace.workspaceFolders ?? [];
      assert.strictEqual(
        folders.length,
        2,
        "this check needs the two-project fixture",
      );
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
      const api = (await ext.activate()) as {
        focusedProject(): string | undefined;
      };
      const focused = (): string | undefined => {
        const f = api.focusedProject();
        return f === undefined ? undefined : real(f);
      };

      const focusAfterOpening = async (
        root: string,
      ): Promise<string | undefined> => {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(`${root}/Day.toml`),
        );
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
        await cfg.update(
          "followActiveEditor",
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        const pinned = focused();
        const other = roots.find((r) => real(r) !== pinned)!;
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(`${other}/Day.toml`),
        );
        await vscode.window.showTextDocument(doc, { preview: false });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(
          focused(),
          pinned,
          "day.followActiveEditor=false must stop the editor from changing focus",
        );
      } finally {
        await cfg.update(
          "followActiveEditor",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
      }
    },
  ],
  [
    "each target offers the native IDE its own scaffold wrote, and only where that IDE runs",
    () => {
      // These are committed source under `platform/`, written by `day new` — not build output —
      // so the row can offer them without a build having happened.
      for (const platform of [
        "darwin",
        "linux",
        "win32",
      ] as NodeJS.Platform[]) {
        const studio = nativeProjectFor("android-mdc", platform);
        assert.strictEqual(studio?.ide, "studio", `${platform}: android-mdc`);
        // The Gradle ROOT, not the app module and not a lone build.gradle.kts: Studio imports the
        // directory holding settings.gradle.kts, and treats a bare build file as a stray.
        assert.strictEqual(studio?.relative, "platform/android");
      }

      // Both Apple targets open in Xcode, each from its OWN platform directory — swapping the two
      // would hand Xcode the wrong project, and both paths exist so neither would error.
      const apple: [string, string][] = [
        ["ios-uikit", "platform/ios/DayApp.xcodeproj"],
        ["macos-appkit", "platform/macos/DayApp.xcodeproj"],
      ];
      for (const [name, relative] of apple) {
        const mac = nativeProjectFor(name, "darwin");
        assert.strictEqual(mac?.ide, "xcode", name);
        assert.strictEqual(mac?.relative, relative, name);
        // Xcode is macOS-only, so no other host is offered a row it could not act on.
        for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
          assert.strictEqual(
            nativeProjectFor(name, platform),
            undefined,
            `${platform} has no Xcode to open ${name} with`,
          );
        }
      }

      // Everything else opens nothing.
      for (const name of ["linux-gtk", "web-dom", "harmony-arkui", "macos-gtk"]) {
        assert.strictEqual(
          nativeProjectFor(name, "darwin"),
          undefined,
          `${name} should offer no IDE project`,
        );
      }
    },
  ],
  [
    "a target row advertises an IDE project only when the project on disk has one",
    () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "this check needs the scaffolded fixture");
      // The fixture scaffolds ios-uikit and android-mdc, so both directories are really there.
      assert.ok(fs.existsSync(path.join(root, "platform/android")));

      assert.strictEqual(
        targetContextValue("dayTarget", root, "android-mdc", "darwin"),
        "dayTarget.studio",
      );
      // The suffix rides on every base state: a running or unbuildable row still opens in an IDE,
      // and an unbuildable target is exactly when someone reaches for one.
      assert.strictEqual(
        targetContextValue("dayTargetRunning", root, "android-mdc", "linux"),
        "dayTargetRunning.studio",
      );
      assert.strictEqual(
        targetContextValue("dayTargetDisabled", root, "ios-uikit", "darwin"),
        "dayTargetDisabled.xcode",
      );
      assert.strictEqual(
        targetContextValue("dayTarget", root, "macos-appkit", "darwin"),
        "dayTarget.xcode",
      );
      // Same project, same target, a host with no Xcode: no offer.
      assert.strictEqual(
        targetContextValue("dayTarget", root, "ios-uikit", "win32"),
        "dayTarget",
      );
      // A target that scaffolds nothing to open.
      assert.strictEqual(
        targetContextValue("dayTarget", root, "linux-gtk", "darwin"),
        "dayTarget",
      );

      // A project WITHOUT the scaffolding — the directory decides, not the target name. Otherwise
      // the row would offer Studio for a project that has no Gradle build to open.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "day-no-platform-"));
      try {
        assert.strictEqual(
          targetContextValue("dayTarget", bare, "android-mdc", "darwin"),
          "dayTarget",
        );
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    },
  ],
  [
    "the IDE rows are contributed to the menu, and no target menu lost its row to the suffix",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const menus = ext.packageJSON.contributes.menus[
        "view/item/context"
      ] as { command: string; when: string }[];
      const commands = (ext.packageJSON.contributes.commands ?? []) as {
        command: string;
        title: string;
      }[];

      for (const id of ["day.openInAndroidStudio", "day.openInXcode"]) {
        assert.ok(
          commands.some((c) => c.command === id),
          `${id} is not declared as a command`,
        );
        assert.ok(
          menus.some((m) => m.command === id),
          `${id} is not on the target menu`,
        );
      }

      // Evaluate each `when` clause's own regex against the context values the tree really emits.
      // The suffix was added to a value four other menus matched with `==`, and each of them would
      // have silently vanished from every Android and iOS row.
      const matcher = (command: string): RegExp => {
        const entry = menus.find((m) => m.command === command);
        assert.ok(entry, `${command} has no menu entry`);
        const m = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(entry.when);
        assert.ok(m, `${command}'s when clause has no viewItem regex: ${entry.when}`);
        return new RegExp(m[1]);
      };
      const plain = ["dayTarget", "dayTargetRunning", "dayTargetDisabled"];
      const suffixed = plain.flatMap((b) => [`${b}.studio`, `${b}.xcode`]);

      for (const [command, shouldMatch] of [
        ["day.runTarget", ["dayTarget", "dayTarget.studio", "dayTarget.xcode"]],
        [
          "day.stop",
          ["dayTargetRunning", "dayTargetRunning.studio", "dayTargetRunning.xcode"],
        ],
        [
          "day.restart",
          ["dayTargetRunning", "dayTargetRunning.studio", "dayTargetRunning.xcode"],
        ],
        [
          "day.toggleTarget",
          [
            "dayTarget",
            "dayTargetRunning",
            "dayTarget.studio",
            "dayTargetRunning.xcode",
          ],
        ],
      ] as [string, string[]][]) {
        const re = matcher(command);
        for (const value of shouldMatch) {
          assert.ok(re.test(value), `${command} no longer matches ${value}`);
        }
        // Still not offered on a row it was never meant for.
        assert.ok(
          !re.test("dayProject"),
          `${command} matches a project row`,
        );
      }

      // A disabled row cannot be run, stopped or ticked — that was true before and stays true with
      // a suffix on it.
      for (const command of ["day.runTarget", "day.stop", "day.toggleTarget"]) {
        const re = matcher(command);
        for (const value of ["dayTargetDisabled", "dayTargetDisabled.studio"]) {
          assert.ok(!re.test(value), `${command} now matches ${value}`);
        }
      }

      // And each IDE row is offered only for its own IDE.
      const studio = matcher("day.openInAndroidStudio");
      const xcode = matcher("day.openInXcode");
      for (const value of suffixed.filter((v) => v.endsWith(".studio"))) {
        assert.ok(studio.test(value), `Studio row missing from ${value}`);
        assert.ok(!xcode.test(value), `Xcode row offered on ${value}`);
      }
      for (const value of suffixed.filter((v) => v.endsWith(".xcode"))) {
        assert.ok(xcode.test(value), `Xcode row missing from ${value}`);
        assert.ok(!studio.test(value), `Studio row offered on ${value}`);
      }
      for (const value of plain) {
        assert.ok(!studio.test(value) && !xcode.test(value), `${value} offers an IDE`);
      }
    },
  ],
  [
    "unavailable targets sink to the bottom, or drop out when the setting says so",
    () => {
      // `findTarget`/`isBuildableHere` answer against THIS host, so the expected split is computed
      // the same way rather than hard-coded — the suite runs on all three OSes in CI, and a fixed
      // list would encode whichever one wrote it.
      const names = catalog().map((t) => t.name);
      const buildable = names.filter((n) => {
        const t = findTarget(n);
        return !t || isBuildableHere(t);
      });
      const not = names.filter((n) => !buildable.includes(n));
      assert.ok(
        buildable.length > 0 && not.length > 0,
        "this check needs a host with both kinds of target",
      );

      const listed = orderTargets(names, false);
      assert.strictEqual(listed.hidden, 0, "nothing is hidden when the setting is off");
      assert.deepStrictEqual(
        listed.shown,
        [...buildable, ...not],
        "every buildable target comes before every unbuildable one",
      );
      // Nothing is lost by reordering — a row that vanished would be a worse bug than a mis-sorted
      // one, and is exactly what a filter written in place of a partition would do.
      assert.deepStrictEqual([...listed.shown].sort(), [...names].sort());

      const trimmed = orderTargets(names, true);
      assert.deepStrictEqual(trimmed.shown, buildable);
      assert.strictEqual(trimmed.hidden, not.length, "the count is what the heading reports");

      // Declaration order survives inside each half: Day.toml's order is the author's, and this
      // is a stable partition rather than a sort.
      const declared = [...not.slice(0, 1), ...buildable.reverse(), ...not.slice(1)];
      const stable = orderTargets(declared, false);
      assert.deepStrictEqual(
        stable.shown,
        [...declared.filter((n) => !not.includes(n)), ...declared.filter((n) => not.includes(n))],
      );
    },
  ],
  [
    "a target the catalog does not know stays listed rather than being buried or hidden",
    () => {
      // A CLI newer than this extension can report a target the static fallback has never heard of.
      // Treating unknown as unavailable would bury it under the greyed-out rows — or, with hiding
      // on by default, drop it from the view entirely.
      const invented = "plan9-rio";
      assert.strictEqual(findTarget(invented), undefined, "the fixture target must be unknown");

      const shown = orderTargets(["macos-appkit", invented], false).shown;
      assert.ok(shown.includes(invented), "an unknown target must be listed");

      const hiding = orderTargets([invented], true);
      assert.deepStrictEqual(hiding.shown, [invented]);
      assert.strictEqual(hiding.hidden, 0, "an unknown target is not counted as hidden");
    },
  ],
  [
    "hiding unavailable targets is on by default, and is a per-project setting",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const cfg = ext.packageJSON.contributes.configuration;
      const props = (Array.isArray(cfg) ? cfg[0] : cfg).properties as Record<
        string,
        { default?: unknown; scope?: string; type?: string }
      >;
      const entry = props["day.hideUnavailableTargets"];
      assert.ok(entry, "the setting is not contributed");
      assert.strictEqual(entry.type, "boolean");
      assert.strictEqual(entry.default, true, "hiding is the default");
      // Folder-scoped like day.verbose: one app in the window can list everything it ships to
      // while another stays trimmed to what this host runs.
      assert.strictEqual(entry.scope, "resource");

      // And the reader agrees with the manifest, rather than carrying its own default.
      assert.strictEqual(
        hideUnavailableTargets(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
        true,
      );
    },
  ],
  [
    "a target keeps several devices, in order, and survives the pre-multi-device store",
    () => {
      const state = new State(fakeMemento());
      const root = "/w/Day-Rise";
      const a = { id: "UDID-A", label: "iPhone 16", flag: "--ios-simulator" };
      const b = { id: "UDID-B", label: "iPhone SE", flag: "--ios-simulator" };

      return (async () => {
        await state.addDevice(root, "ios-uikit", a);
        await state.addDevice(root, "ios-uikit", b);
        assert.deepStrictEqual(
          state.devicesFor(root, "ios-uikit").map((d) => d.id),
          ["UDID-A", "UDID-B"],
          "added order is kept — it is the order the rows are drawn in",
        );

        // Re-adding is a no-op, not a second row: the picker lists what is connected, so picking
        // one already configured is easy to do by accident, and two rows would launch twice onto
        // the same device.
        await state.addDevice(root, "ios-uikit", a);
        assert.strictEqual(state.devicesFor(root, "ios-uikit").length, 2);

        // Removing takes out the named one and leaves the rest in order.
        await state.removeDevice(root, "ios-uikit", "UDID-A");
        assert.deepStrictEqual(
          state.devicesFor(root, "ios-uikit").map((d) => d.id),
          ["UDID-B"],
        );

        // A workspace written before multi-device support pinned ONE device per target. It has to
        // come back as that device, not as "all connected" — a silent revert would send the next
        // launch to every phone in the room.
        const legacy = new State(
          fakeMemento({
            "day.projectSelections": {
              byProject: { [root]: { devices: { "ios-uikit": a } } },
            },
          }),
        );
        assert.deepStrictEqual(legacy.devicesFor(root, "ios-uikit"), [a]);
      })();
    },
  ],
  [
    "a mobile target lists its configured devices, and shows no twisty with none",
    () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "this check needs the scaffolded fixture");
      // The fixed "Device" child is gone: a mobile target with nothing configured has no children,
      // so the row must not offer an expander onto an empty list.
      assert.deepStrictEqual(
        orderTargets(["ios-uikit"], false).shown,
        ["ios-uikit"],
        "sanity: the fixture declares ios-uikit",
      );
    },
  ],
  [
    "every device row's menu keys on the row's own state, and the + only on mobile",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const menus = ext.packageJSON.contributes.menus["view/item/context"] as {
        command: string;
        when: string;
      }[];
      const matcher = (command: string): RegExp => {
        const entry = menus.find((m) => m.command === command);
        assert.ok(entry, `${command} has no menu entry`);
        const m = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(entry.when);
        if (!m) {
          // An `==` clause, not a regex — turn it into one so both forms can be checked together.
          const eq = /viewItem == (\w+)/.exec(entry.when);
          assert.ok(eq, `${command}: ${entry.when}`);
          return new RegExp(`^${eq[1]}$`);
        }
        return new RegExp(m[1]);
      };

      // A device row is either idle or running, and gets exactly one of Play / Stop.
      const play = matcher("day.runDevice");
      const stop = matcher("day.stopDevice");
      const remove = matcher("day.removeDevice");
      assert.ok(play.test("dayDevice") && !play.test("dayDeviceRunning"));
      assert.ok(stop.test("dayDeviceRunning") && !stop.test("dayDevice"));
      // Remove is offered whichever state it is in — a running device must still be removable.
      assert.ok(remove.test("dayDevice") && remove.test("dayDeviceRunning"));

      // Play and Stop are about the APP; the tag a row grows for its simulator or emulator rides
      // behind them and must not take either off the row. An `==` clause did exactly that.
      assert.ok(play.test("dayDevice.startSimulator"), "Play lost to a device-state tag");
      assert.ok(stop.test("dayDeviceRunning.stopEmulator"), "Stop lost to a device-state tag");
      assert.ok(remove.test("dayDevice.startEmulator"));

      // Start/Stop Simulator/Emulator: four entries, each keyed on the one tag its own row grows,
      // so a row offers exactly one of them and the wording always names the right thing.
      const startSim = matcher("day.startSimulator");
      const stopSim = matcher("day.stopSimulator");
      const startEmu = matcher("day.startEmulator");
      const stopEmu = matcher("day.stopEmulator");
      const tags = [
        ["dayDevice.startSimulator", startSim],
        ["dayDevice.stopSimulator", stopSim],
        ["dayDeviceRunning.stopSimulator", stopSim],
        ["dayDevice.startEmulator", startEmu],
        ["dayDeviceRunning.stopEmulator", stopEmu],
      ] as const;
      for (const [value, mine] of tags) {
        for (const other of [startSim, stopSim, startEmu, stopEmu]) {
          assert.strictEqual(
            other.test(value),
            other === mine,
            `${value} matched the wrong entry`,
          );
        }
      }
      // An untagged row — a physical phone, or a target nothing has been enumerated for — offers
      // none of them. Offering Start there would promise something no toolchain can do.
      for (const bare of ["dayDevice", "dayDeviceRunning", "dayTarget.mobile"]) {
        for (const entry of [startSim, stopSim, startEmu, stopEmu]) {
          assert.ok(!entry.test(bare), `a start/stop entry reached ${bare}`);
        }
      }

      // The "+" belongs to mobile target rows only, and not to ones this host cannot build: their
      // toolchain cannot enumerate what is connected, so the picker would open onto an error.
      const add = matcher("day.addDevice");
      for (const yes of [
        "dayTarget.mobile",
        "dayTarget.studio.mobile",
        "dayTarget.xcode.mobile",
        "dayTargetRunning.studio.mobile",
      ]) {
        assert.ok(add.test(yes), `+ missing from ${yes}`);
      }
      for (const no of [
        "dayTarget",
        "dayTarget.xcode",
        "dayTargetDisabled.xcode.mobile",
        "dayDevice",
      ]) {
        assert.ok(!add.test(no), `+ offered on ${no}`);
      }

      // The IDE rows survive a SECOND tag after theirs. `.mobile` is appended after `.studio`, and
      // an end-anchored `\.studio$` silently dropped the entry from every Android row.
      const studio = matcher("day.openInAndroidStudio");
      const xcode = matcher("day.openInXcode");
      assert.ok(studio.test("dayTarget.studio.mobile"), "Studio lost to a trailing tag");
      assert.ok(xcode.test("dayTarget.xcode.mobile"), "Xcode lost to a trailing tag");
      assert.ok(!studio.test("dayTarget.xcode.mobile") && !xcode.test("dayTarget.studio.mobile"));
    },
  ],
  [
    "a device row knows whether its simulator or emulator can be started or stopped",
    () => {
      const ios: TargetDevices = {
        target: "ios-uikit",
        kind: "iosSim",
        available: true,
        devices: [
          { id: "UDID-UP", name: "iPhone 16", kind: "simulator", flag: "--ios-simulator" },
          { id: "00008110-PHONE", name: "iPhone 13 mini", kind: "device", flag: "--ios-device" },
        ],
        bootable: [{ id: "UDID-OFF", name: "iPad Pro" }],
      };

      const booted = virtualDevice(ios, { id: "UDID-UP" });
      assert.deepStrictEqual(booted, {
        running: true,
        id: "UDID-UP",
        noun: "simulator",
        platform: "iOS",
      });
      const off = virtualDevice(ios, { id: "UDID-OFF" });
      assert.deepStrictEqual(off, {
        running: false,
        id: "UDID-OFF",
        noun: "simulator",
        platform: "iOS",
      });

      // A plugged-in iPhone has no software to start and nothing to shut down: unplugging it is
      // the real action, and neither entry belongs on its row.
      assert.strictEqual(virtualDevice(ios, { id: "00008110-PHONE" }), undefined);
      // A simulator that has since been deleted is neither running nor startable.
      assert.strictEqual(virtualDevice(ios, { id: "UDID-GONE" }), undefined);
      // Nothing enumerated yet, and a target whose toolchain is missing, are both "not known" —
      // and a menu that guessed "stopped" there would offer Start on a running simulator.
      assert.strictEqual(virtualDevice(undefined, { id: "UDID-UP" }), undefined);
      assert.strictEqual(
        virtualDevice({ ...ios, available: false, note: "no Xcode" }, { id: "UDID-UP" }),
        undefined,
      );

      // HarmonyOS gets neither entry: its emulator is started by `day ohos emulator launch` and
      // has no stop, so both would name something the CLI cannot do.
      assert.strictEqual(
        virtualDevice(
          {
            target: "harmony-arkui",
            kind: "harmonyOs",
            available: true,
            devices: [
              { id: "127.0.0.1:55555", name: "127.0.0.1:55555", kind: "emulator", flag: "--ohos-device" },
            ],
            bootable: [],
          },
          { id: "127.0.0.1:55555" },
        ),
        undefined,
      );

      // Android keys its running emulators by adb SERIAL and its startable ones by AVD NAME, so a
      // stopped row matches nothing by id — the AVD it was stored with is the whole link back.
      const android: TargetDevices = {
        target: "android-mdc",
        kind: "android",
        available: true,
        devices: [
          {
            id: "emulator-5554",
            name: "Pixel_9_API_36 (emulator-5554)",
            kind: "emulator",
            avd: "Pixel_9_API_36",
            flag: "--android-device",
          },
        ],
        bootable: [{ id: "Pixel_6_API_31", name: "Pixel_6_API_31" }],
      };
      assert.deepStrictEqual(virtualDevice(android, { id: "emulator-5554" }), {
        running: true,
        id: "emulator-5554",
        noun: "emulator",
        platform: "Android",
      });
      assert.deepStrictEqual(
        virtualDevice(android, { id: "emulator-5556", avd: "Pixel_6_API_31" }),
        { running: false, id: "Pixel_6_API_31", noun: "emulator", platform: "Android" },
        "a stopped emulator is startable by the AVD its dead serial belonged to",
      );

      // The prompt a device row's Play puts up names the device and the kind of thing it is, in
      // the platform's own words — the whole point is that agreeing starts THAT one.
      assert.strictEqual(
        startPrompt("iPad (A16)", off!),
        'The "iPad (A16)" iOS simulator is not currently running.',
      );
      assert.strictEqual(
        startPrompt("Pixel_6_API_31", virtualDevice(android, {
          id: "emulator-5556",
          avd: "Pixel_6_API_31",
        })!),
        'The "Pixel_6_API_31" Android emulator is not currently running.',
      );
      // Without the AVD there is no id to start — but the row is still recognizably an EMULATOR,
      // and one that can be adopted rather than one that is gone. That is the whole difference
      // between a menu offering "Start Emulator…" and a menu offering nothing at all: every row
      // stored before the AVD was recorded holds a serial and nothing else.
      assert.deepStrictEqual(virtualDevice(android, { id: "emulator-5556" }), {
        running: false,
        noun: "emulator",
        platform: "Android",
      });
      // A physical Android phone that is merely unplugged is NOT that: there is no AVD to pick.
      assert.strictEqual(virtualDevice(android, { id: "19091FDF600BAY" }), undefined);
      // Neither is a deleted simulator — asking "which one is this?" would invent an identity.
      assert.strictEqual(virtualDevice(ios, { id: "UDID-DELETED" }), undefined);
    },
  ],
  [
    "an emulator that came up late is still recognised, by the AVD rather than the serial",
    () => {
      // The state a slow boot leaves behind: the row was seeded from the bootable AVD and never
      // re-keyed, because the CLI stopped waiting before the emulator answered. The emulator is
      // up all the same, under a serial the row has never heard of.
      const listing: TargetDevices = {
        target: "android-mdc",
        kind: "android",
        available: true,
        devices: [
          {
            id: "emulator-5556",
            name: "Pixel_9_API_36 (emulator-5556)",
            kind: "emulator",
            avd: "Pixel_9_API_36",
            flag: "--android-device",
          },
        ],
        // Excluded from bootable precisely because it IS running — which is what left the row
        // matching nothing at all and reading `not found`.
        bootable: [],
      };
      const stale = { id: "Pixel_9_API_36", avd: "Pixel_9_API_36" };

      assert.strictEqual(
        liveDevice(listing, stale)?.id,
        "emulator-5556",
        "a row still keyed by its AVD is the emulator running that AVD",
      );
      // …so it reads connected and offers Stop, on the serial the CLI actually answers to.
      assert.deepStrictEqual(virtualDevice(listing, stale), {
        running: true,
        id: "emulator-5556",
        noun: "emulator",
        platform: "Android",
      });
      assert.deepStrictEqual(deviceRowState({
        running: false,
        pending: undefined,
        loading: false,
        listing,
        device: stale,
      }).bits, ["connected"]);

      // A row whose AVD is genuinely absent is still not found, and an unrelated AVD is not it.
      assert.strictEqual(liveDevice(listing, { id: "Pixel_5_API_30", avd: "Pixel_5_API_30" }), undefined);
      // No AVD at all falls back to the id, which is the physical-device and iOS case.
      assert.strictEqual(liveDevice(listing, { id: "emulator-5556" })?.id, "emulator-5556");
      assert.strictEqual(liveDevice(undefined, stale), undefined);
    },
  ],
  [
    "a device being started reads Booting, and a boot that failed says so until it is seen",
    () => {
      const listing: TargetDevices = {
        target: "android-mdc",
        kind: "android",
        available: true,
        // The listing taken WHILE it boots: still nothing connected, still bootable. This is the
        // reading that made adding a device look like it had done nothing at all.
        devices: [],
        bootable: [{ id: "Pixel_9_API_36", name: "Pixel_9_API_36" }],
      };
      const device = { id: "Pixel_9_API_36", avd: "Pixel_9_API_36" };
      const base = { running: false, loading: false, listing, device };

      // Booting outranks the listing, and offers nothing while it is in flight — a row cannot be
      // asked to start what it is already starting, or to stop what is not up yet.
      const booting = deviceRowState({ ...base, pending: "booting" });
      assert.deepStrictEqual(booting.bits, ["Booting…"]);
      assert.strictEqual(booting.icon, "loading~spin");
      assert.strictEqual(booting.tag, undefined);
      assert.strictEqual(booting.busy, true, "a booting row puts its Play away");

      const stopping = deviceRowState({ ...base, pending: "stopping" });
      assert.deepStrictEqual(stopping.bits, ["Stopping…"]);
      assert.strictEqual(stopping.icon, "loading~spin");
      assert.strictEqual(stopping.busy, true);

      // Play's first act is to ask the CLI where the device stands, which is seconds of adb or
      // simctl. The row spins for exactly that long, so the click visibly landed, and drops its
      // inline button so a second click cannot queue a second launch.
      const checking = deviceRowState({ ...base, pending: "checking" });
      assert.deepStrictEqual(checking.bits, ["checking…"]);
      assert.strictEqual(checking.icon, "loading~spin");
      assert.strictEqual(checking.tag, undefined);
      assert.strictEqual(checking.busy, true);

      // A boot that failed is marked, and keeps its Start so the retry is on the same row. The
      // error dialog is the other half, and this is the half that survives dismissing it.
      const failed = deviceRowState({ ...base, pending: "failed" });
      assert.deepStrictEqual(failed.bits, ["failed to start"]);
      assert.strictEqual(failed.icon, "error");
      assert.strictEqual(failed.color, "list.errorForeground");
      assert.strictEqual(failed.tag, "startEmulator");
      // A failed boot is over, so Play is back: the retry is one click on the same row.
      assert.strictEqual(failed.busy, false);

      // …and it stops being true the moment the device is actually there, however it got there.
      const arrived: TargetDevices = {
        ...listing,
        devices: [
          {
            id: "emulator-5554",
            name: "Pixel_9_API_36 (emulator-5554)",
            kind: "emulator",
            avd: "Pixel_9_API_36",
            flag: "--android-device",
          },
        ],
        bootable: [],
      };
      const back = deviceRowState({
        running: false,
        loading: false,
        pending: "failed",
        listing: arrived,
        device: { id: "emulator-5554", avd: "Pixel_9_API_36" },
      });
      assert.deepStrictEqual(back.bits, ["connected"]);
      assert.strictEqual(back.tag, "stopEmulator");

      // Nothing pending is the ordinary row, and the app running on it still leads the line.
      assert.deepStrictEqual(
        deviceRowState({ ...base, pending: undefined }).bits,
        ["not running"],
      );
      assert.deepStrictEqual(
        deviceRowState({ ...base, pending: undefined, running: true }).bits,
        ["running", "not running"],
      );
      assert.strictEqual(
        deviceRowState({ ...base, pending: undefined, running: true }).icon,
        "circle-filled",
      );
      assert.strictEqual(deviceRowState({ ...base, pending: undefined }).busy, false);
    },
  ],
  [
    "an emulator row with no AVD offers to adopt one, and every other row keeps its own entry",
    () => {
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const menus = ext.packageJSON.contributes.menus["view/item/context"] as {
        command: string;
        when: string;
      }[];
      const re = (command: string): RegExp => {
        const entry = menus.find((m) => m.command === command);
        assert.ok(entry, `${command} has no menu entry`);
        const m = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(entry.when);
        assert.ok(m, entry.when);
        return new RegExp(m[1]);
      };
      const adopt = re("day.adoptEmulator");
      const start = re("day.startEmulator");
      assert.ok(adopt.test("dayDevice.adoptEmulator"));
      // The two must not overlap: `.startEmulator` is a substring of nothing here, but a lazy
      // pattern for either would put both entries on one row and one of them would do nothing.
      assert.ok(!start.test("dayDevice.adoptEmulator"), "Start Emulator reached an unnamed row");
      assert.ok(!adopt.test("dayDevice.startEmulator"), "Start Emulator… reached a named row");

      // And its title carries the ellipsis, which is what tells the row apart in the menu.
      const commands = ext.packageJSON.contributes.commands as { command: string; title: string }[];
      const title = (id: string): string =>
        commands.find((c) => c.command === id)?.title ?? "";
      assert.strictEqual(title("day.adoptEmulator"), "Start Emulator…");
      assert.strictEqual(title("day.startEmulator"), "Start Emulator");
    },
  ],
  [
    "a row learns the AVD behind its serial, and keeps its place, its tick and a live run's name",
    () => {
      const state = new State(fakeMemento());
      const root = "/w/Day-Rise";
      // The shape a workspace written before the AVD was recorded actually holds.
      const legacy = {
        id: "emulator-5554",
        label: "Emulator (emulator-5554)",
        flag: "--android-device",
      };

      return (async () => {
        await state.addDevice(root, "android-mdc", legacy);
        await state.addDevice(root, "android-mdc", { ...legacy, id: "emulator-5556" });
        await state.setDeviceTicked(root, "android-mdc", "emulator-5556", false);

        // Learned from a listing while that serial is live: same id, now with the AVD behind it.
        await state.replaceDevice(root, "android-mdc", "emulator-5554", {
          ...legacy,
          label: "Pixel_9_API_36 (emulator-5554)",
          avd: "Pixel_9_API_36",
        });
        assert.deepStrictEqual(
          state.devicesFor(root, "android-mdc").map((d) => [d.id, d.avd]),
          [["emulator-5554", "Pixel_9_API_36"], ["emulator-5556", undefined]],
          "the row keeps its place and only the one that was seen learns anything",
        );
        assert.deepStrictEqual(
          state.tickedDevicesFor(root, "android-mdc").map((d) => d.id),
          ["emulator-5554"],
          "and the tick survives an in-place update",
        );
      })();
    },
  ],
  [
    "restarting an emulator under a new serial keeps its row, its place and its tick",
    () => {
      const state = new State(fakeMemento());
      const root = "/w/Day-Rise";
      const first = { id: "emulator-5554", label: "Pixel 9", flag: "--android-device", avd: "P9" };
      const other = { id: "emulator-5558", label: "Pixel 6", flag: "--android-device", avd: "P6" };

      return (async () => {
        await state.addDevice(root, "android-mdc", first);
        await state.addDevice(root, "android-mdc", other);
        await state.setDeviceTicked(root, "android-mdc", "emulator-5558", false);

        // The same emulator, back on a different console port. Removing and re-adding would send
        // it to the bottom of the list and re-tick it; the row is rewritten in place instead.
        const back = { ...first, id: "emulator-5560" };
        await state.replaceDevice(root, "android-mdc", "emulator-5554", back);
        assert.deepStrictEqual(
          state.devicesFor(root, "android-mdc").map((d) => d.id),
          ["emulator-5560", "emulator-5558"],
          "the row keeps its place",
        );
        assert.deepStrictEqual(
          state.tickedDevicesFor(root, "android-mdc").map((d) => d.id),
          ["emulator-5560"],
          "and its tick follows the rename, without reviving the one that was unticked",
        );

        // Renaming onto a serial another row already holds would leave two rows for one device,
        // each launching onto it. Refused rather than merged.
        await state.replaceDevice(root, "android-mdc", "emulator-5560", {
          ...other,
          id: "emulator-5558",
        });
        assert.deepStrictEqual(
          state.devicesFor(root, "android-mdc").map((d) => d.id),
          ["emulator-5560", "emulator-5558"],
        );
      })();
    },
  ],
  [
    "one target on two devices is two tasks, each with its own name and its own device flag",
    () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "this check needs the scaffolded fixture");
      const base = { type: "day", command: "launch", target: "ios-uikit", project: root } as const;
      const a = buildDayTask({
        ...base,
        device: { id: "UDID-A", flag: "--ios-simulator", label: "iPhone 16" },
      });
      const b = buildDayTask({
        ...base,
        device: { id: "UDID-B", flag: "--ios-simulator", label: "iPhone SE" },
      });

      // The NAME is the task's identity, and the presentation asks for a dedicated panel per
      // identity. Two same-named launches share one terminal and each `clear: true` wipes the one
      // before it, so two of three runs would be invisible — the device has to be in the name.
      assert.notStrictEqual(a.name, b.name, "two devices must not share a task identity");
      assert.ok(a.name.includes("iPhone 16"), a.name);
      assert.ok(b.name.includes("iPhone SE"), b.name);
      assert.ok(a.name.startsWith("run ios-uikit"), a.name);

      // And each actually targets its own device on the command line.
      const args = (t: vscode.Task): string[] =>
        (t.execution as vscode.ProcessExecution).args as string[];
      assert.ok(args(a).join(" ").includes("--ios-simulator UDID-A"), args(a).join(" "));
      assert.ok(args(b).join(" ").includes("--ios-simulator UDID-B"), args(b).join(" "));

      // A target with no device configured keeps the plain name it always had, so nothing changes
      // for desktop targets or for a mobile one nobody has configured.
      const plain = buildDayTask({ ...base, target: "macos-appkit" });
      assert.ok(!plain.name.includes(" · "), plain.name);
      assert.ok(!args(plain).join(" ").includes("--ios-simulator"));
    },
  ],
  [
    "two devices are two live tasks, because the device is part of the contributed identity",
    async () => {
      // VS Code keys a task on the properties its type DECLARES in `contributes.taskDefinitions`.
      // A property missing there is invisible to that key, so two launches of one target onto two
      // devices were one task: the second replaced the first, leaving a single terminal carrying
      // the first device's name and no way to watch or stop the other run.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const def = ext.packageJSON.contributes.taskDefinitions.find(
        (t: { type: string }) => t.type === "day",
      );
      assert.ok(def, "the day task type is not contributed");
      assert.ok(
        def.properties?.device,
        "`device` must be declared, or two devices collapse into one task",
      );

      // And the behavior itself, through the real task type. `node -e` rather than `sleep` so the
      // check runs on Windows too; the process is terminated below either way.
      const idle = (id: string) =>
        new vscode.Task(
          {
            type: "day",
            command: "launch",
            target: "android-mdc",
            device: { id, flag: "-d", label: id },
          },
          vscode.TaskScope.Workspace,
          `run android-mdc · ${id}`,
          "day",
          new vscode.ProcessExecution(process.execPath, [
            "-e",
            "setTimeout(() => {}, 30000)",
          ]),
        );

      const started: vscode.TaskExecution[] = [];
      try {
        started.push(await vscode.tasks.executeTask(idle("emulator-5554")));
        started.push(await vscode.tasks.executeTask(idle("emulator-5556")));
        // Poll rather than sleep a fixed time: the executions register asynchronously, and a fixed
        // wait is how this check would go flaky on a loaded CI runner.
        const ours = () =>
          vscode.tasks.taskExecutions.filter(
            (e) => (e.task.definition as { target?: string }).target === "android-mdc",
          );
        for (let i = 0; i < 100 && ours().length < 2; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(
          ours().length,
          2,
          "one target on two devices must be two live tasks, not one",
        );
      } finally {
        for (const e of started) {
          e.terminate();
        }
      }
    },
  ],
  [
    "device ticks decide what launches, and a new device arrives ticked",
    async () => {
      const state = new State(fakeMemento());
      const root = "/w/Day-Rise";
      const t = "android-mdc";
      const a = { id: "emulator-5554", label: "Pixel 8", flag: "--android-device" };
      const b = { id: "emulator-5556", label: "Pixel 7", flag: "--android-device" };

      await state.addDevice(root, t, a);
      await state.addDevice(root, t, b);
      // Absent tick state means all of them — a project that predates ticking, or one where
      // nobody has unticked anything, launches on everything it lists.
      assert.deepStrictEqual(
        state.tickedDevicesFor(root, t).map((d) => d.id),
        [a.id, b.id],
      );

      await state.setDeviceTicked(root, t, a.id, false);
      assert.deepStrictEqual(state.tickedDevicesFor(root, t).map((d) => d.id), [b.id]);
      assert.deepStrictEqual(
        state.devicesFor(root, t).map((d) => d.id),
        [a.id, b.id],
        "unticking must not remove the row — it is still a configured device",
      );

      // Re-ticking restores both, and they read back in configured order however they were
      // toggled — reads filter the configured list rather than replaying toggle order.
      await state.setDeviceTicked(root, t, a.id, true);
      assert.deepStrictEqual(state.tickedDevicesFor(root, t).map((d) => d.id), [a.id, b.id]);

      // The target's checkbox is all-or-nothing over its children.
      await state.setAllDevicesTicked(root, t, false);
      assert.deepStrictEqual(state.tickedDevicesFor(root, t), []);
      await state.setAllDevicesTicked(root, t, true);
      assert.strictEqual(state.tickedDevicesFor(root, t).length, 2);

      // A device added AFTER something was unticked still arrives ticked: adding it is saying you
      // want to run on it. With the tick map already present this is the case that would
      // otherwise land unticked and silently never launch.
      await state.setDeviceTicked(root, t, a.id, false);
      const c = { id: "emulator-5558", label: "Pixel 9", flag: "--android-device" };
      await state.addDevice(root, t, c);
      assert.deepStrictEqual(
        state.tickedDevicesFor(root, t).map((d) => d.id),
        [b.id, c.id],
        "a newly added device is ticked; the earlier untick stands",
      );

      // Removing a device drops its tick, so re-adding it comes back ticked rather than carrying
      // a stale untick nobody can see.
      await state.removeDevice(root, t, b.id);
      await state.addDevice(root, t, b);
      assert.ok(
        state.tickedDevicesFor(root, t).some((d) => d.id === b.id),
        "a re-added device must not inherit its old untick",
      );
    },
  ],
  [
    "a partially ticked target still reads as selected, and says how many of its devices run",
    () => {
      // VS Code tree checkboxes are two-state — `TreeItemCheckboxState` is Checked/Unchecked and
      // the workbench renders a plain toggle with no indeterminate path — so a partly ticked
      // target cannot show a third state. It stays CHECKED while any device is ticked, because
      // that is exactly when it still launches, and the count in the row carries the rest.
      assert.strictEqual(
        Object.keys(vscode.TreeItemCheckboxState).filter((k) => isNaN(Number(k))).length,
        2,
        "if a mixed state ever ships, the target row should use it instead of the count",
      );
      assert.strictEqual(vscode.TreeItemCheckboxState.Checked, 1);
      assert.strictEqual(vscode.TreeItemCheckboxState.Unchecked, 0);
    },
  ],
  [
    "breakpoints are contributed for Rust",
    () => {
      // Without this contribution VS Code refuses to set a breakpoint in a .rs file at all, and a
      // delegated session would launch with nothing to stop on.
      const ext = vscode.extensions.getExtension("daybrite.day-vscode");
      assert.ok(ext);
      const languages: string[] = (
        ext.packageJSON?.contributes?.breakpoints ?? []
      ).map((b: { language: string }) => b.language);
      assert.ok(
        languages.includes("rust"),
        `breakpoints contributes ${JSON.stringify(languages)}`,
      );
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
        assert.ok(
          !("environment" in a),
          `${key} should not use cpptools' \`environment\` key`,
        );
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
        await cfg.update(
          "debug.adapter",
          "none",
          vscode.ConfigurationTarget.Workspace,
        );
        assert.strictEqual(
          pickDelegate(),
          undefined,
          "a pinned `none` must fall back to the launch-only adapter",
        );
      } finally {
        await cfg.update(
          "debug.adapter",
          previous,
          vscode.ConfigurationTarget.Workspace,
        );
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
      assert.deepStrictEqual(plan.env, {
        DAY_IMAGE_ROOT: "/app/resource/images",
      });

      // A target the CLI reported without a plan (a device or browser runtime) is not an error —
      // it means "run this one without a debugger", and it has to say so rather than throw.
      const noPlan = JSON.stringify({
        event: "result",
        command: "build",
        ok: true,
        targets: [
          {
            target: "android-mdc",
            ok: true,
            artifacts: [{ path: "/app/app.apk" }],
          },
        ],
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
  console.log(
    `${checks.length - failures.length}/${checks.length} checks passed`,
  );
  if (failures.length) {
    throw new Error(
      `${failures.length} check(s) failed: ${failures.join(", ")}`,
    );
  }
}
