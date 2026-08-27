// Day extension entry point: discovers Day.toml projects, wires the sidebar tree, status bar, task
// provider, and commands, and drives build/run/stop/restart through the Runner (Tasks API).

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  MCP_PROVIDER_ID,
  mcpServerSpec,
  renderCommand,
  resolveCli,
  setExtensionRoot,
} from "./cli";
import { State } from "./config";
import { DayConfigProvider, DayDebugAdapterFactory } from "./debug";
import { promptToInstall } from "./install";
import { editFor, Lint, LintActions } from "./lint";
import { askAll, composeArgs, describeSpec } from "./newproject";
import * as devices from "./devices";
import { DayProject, findProjects, ProjectLoadFailure } from "./project";
import {
  pickDevice,
  pickLocale,
  pickLogLevel,
  pickMode,
  pickProject,
  pickScript,
  pickTargets,
} from "./quickpicks";
import { RunRef, Runner } from "./runner";
import { StatusBar } from "./statusbar";
import { DayTaskProvider } from "./taskProvider";
import { logLevel, setLogLevel, toggleVerbose, toolchainEnv } from "./tasks";
import { findTarget, isBuildableHere } from "./targets";
import { DayTree, Node } from "./tree";

/**
 * What `activate` hands back to VS Code, and therefore to anyone holding this extension.
 *
 * Deliberately tiny: the focused project decides what the Configuration rows, the Run button and
 * the status bar act on, and it is otherwise only visible as sidebar decoration — which the
 * integration suite cannot read. Exposing the one value keeps that behavior testable without
 * reaching into module internals.
 */
/** globalState key: whether this install has ever shown the walkthrough. */
const SEEN_WALKTHROUGH = "day.seenWalkthrough";

export interface DayApi {
  /** Root of the project the cockpit is currently pointed at, if any. */
  focusedProject(): string | undefined;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<DayApi> {
  // Record where the extension is loaded from, so the CLI resolver can find a peer `day/` repo
  // when running from a source checkout (see cli.ts `findPeerDayRepo`). Must precede any scan.
  setExtensionRoot(context.extensionPath);

  const state = new State(context.workspaceState);
  const runner = new Runner(state);
  context.subscriptions.push(runner);

  const output = vscode.window.createOutputChannel("Day");
  context.subscriptions.push(output);

  const lint = new Lint(output);
  context.subscriptions.push(lint);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new LintActions(lint),
      {
        providedCodeActionKinds: LintActions.kinds,
      },
    ),
  );

  let projects: DayProject[] = [];
  let loadFailures: ProjectLoadFailure[] = [];
  // The last failure set we notified about, so a re-scan with the same problem doesn't nag.
  let lastFailureKey = "";

  const currentProject = (): DayProject | undefined => {
    const root = state.focusedRoot;
    return projects.find((p) => p.root === root) ?? projects[0];
  };

  /** Every discovered project, in sidebar order — what the fan-out tree and Run All walk. */
  const allProjects = (): DayProject[] => projects;

  /**
   * The project a file belongs to, or `undefined` for anything outside one.
   *
   * Longest root wins, so a Day project nested inside another (an example app inside a framework
   * checkout) claims its own files rather than its parent's.
   */
  const projectForUri = (uri: vscode.Uri): DayProject | undefined => {
    if (uri.scheme !== "file") {
      return undefined; // output panes, debug consoles, untitled buffers — not anyone's source
    }
    // Both spellings of the file, because the two sides resolve symlinks differently: `day
    // metadata` reports a canonical root (`/private/tmp/…` on macOS) while an editor URI keeps the
    // path the user opened (`/tmp/…`). Comparing one against the other matched nothing, so a
    // workspace anywhere under a symlink — macOS's /tmp, a symlinked ~/src, a network mount —
    // never followed the editor at all.
    const spellings = new Set([uri.fsPath]);
    try {
      spellings.add(fs.realpathSync.native(uri.fsPath));
    } catch {
      // The file is gone or unreadable; the path as opened is the best we have.
    }
    const within = (file: string, root: string): boolean => {
      const [f, r] =
        process.platform === "win32"
          ? [file.toLowerCase(), root.toLowerCase()]
          : [file, root];
      return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
    };
    let best: DayProject | undefined;
    for (const project of projects) {
      const inside = [...spellings].some((file) => within(file, project.root));
      if (inside && (!best || project.root.length > best.root.length)) {
        best = project;
      }
    }
    return best;
  };

  /** Focus the project an editor belongs to, when the user has left that behavior on. */
  const followEditor = async (
    editor: vscode.TextEditor | undefined,
  ): Promise<void> => {
    if (!editor) {
      return; // switching to a non-editor pane says nothing about which app is being worked on
    }
    if (
      !vscode.workspace
        .getConfiguration("day")
        .get<boolean>("followActiveEditor", true)
    ) {
      return;
    }
    const project = projectForUri(editor.document.uri);
    // A file outside every project — most often something in the `day` checkout itself — leaves
    // the focus where it was rather than clearing it.
    if (project && project.root !== state.focusedRoot) {
      await state.focus(project.root);
    }
  };

  // When a Day.toml was found but its metadata couldn't be loaded, say so plainly — otherwise the
  // sidebar's "No Day project found" hides a CLI problem (e.g. no `day` on PATH). Details always
  // go to the Day output channel; a notification fires once per distinct failure set.
  const reportLoadFailures = (): void => {
    if (loadFailures.length === 0) {
      lastFailureKey = "";
      return;
    }
    for (const f of loadFailures) {
      output.appendLine(`✗ could not load ${f.root}`);
      output.appendLine(`    tried: ${f.command}`);
      output.appendLine(`    error: ${f.message}`);
    }
    const key = loadFailures
      .map((f) => `${f.root}\u0000${f.message}`)
      .join("|");
    if (key === lastFailureKey) {
      return;
    }
    lastFailureKey = key;
    // A missing CLI is the one failure with an obvious next step, so it gets its own message and
    // leads with that step instead of pointing at a setting the reader has no value for yet.
    const missing = loadFailures.some((f) => f.notFound);
    const n = loadFailures.length;
    const subject = `${n} Day project${n > 1 ? "s" : ""}`;
    const message = missing
      ? `Day: the \`day\` CLI isn't installed, so ${subject} couldn't be read. Every build and launch runs through it.`
      : `Day: found ${subject} but couldn't load ${n > 1 ? "them" : "it"} — ${loadFailures[0].message}.`;
    const actions = missing
      ? ["Install the day CLI", "Set the path", "Show Log"]
      : ["Show Log", "Open Settings"];
    void vscode.window.showErrorMessage(message, ...actions).then((choice) => {
      if (choice === "Show Log") {
        output.show(true);
      } else if (choice === "Install the day CLI") {
        void promptToInstall();
      } else if (choice === "Set the path" || choice === "Open Settings") {
        void vscode.commands.executeCommand("day.openSettings");
      }
    });
  };

  const refreshProjects = async (): Promise<void> => {
    const scan = await findProjects();
    projects = scan.projects;
    loadFailures = scan.failures;
    const root = state.focusedRoot;
    if (
      (!root || !projects.find((p) => p.root === root)) &&
      projects.length > 0
    ) {
      await state.focus(projects[0].root);
    }
    // Drives the alternate "found it but couldn't load it" welcome view (package.json).
    void vscode.commands.executeCommand(
      "setContext",
      "day.loadError",
      loadFailures.length > 0 && projects.length === 0,
    );
    reportLoadFailures();
  };

  await refreshProjects();
  // The editor that is already open when the window starts decides the first focus, so reopening a
  // workspace lands on whatever was being worked on rather than on whichever project sorts first.
  await followEditor(vscode.window.activeTextEditor);

  // Once, on the first activation this install ever has. VS Code already offers the walkthrough
  // on its Welcome page, which is the route for someone with no Day project — this covers the
  // other order, where the first thing that happens is opening a project someone else made.
  // Remembered in globalState, so it does not reappear per window or per workspace.
  //
  // `day.showWalkthroughOnStartup` overrides that memory. It is the only channel a script has:
  // `code` hands a new window to an ALREADY-RUNNING VS Code, which does not inherit the calling
  // shell's environment, so an env var would work exactly once per reboot and look flaky.
  const alwaysShow = vscode.workspace
    .getConfiguration("day")
    .get<boolean>("showWalkthroughOnStartup", false);
  if (alwaysShow || !context.globalState.get<boolean>(SEEN_WALKTHROUGH)) {
    void context.globalState.update(SEEN_WALKTHROUGH, true);
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#welcome`,
      // Beside the editor rather than taking it over: the person opened a project to work on it.
      true,
    );
  }

  // Enumerating devices shells out to simctl/adb/hdc, so it happens on demand — a device row
  // asks the first time it draws — and the tree redraws when the answer arrives.
  const refreshDevices = async (target: string): Promise<void> => {
    // `devices.list` coalesces per target, so a row redrawing while its own query is still in
    // flight joins that one instead of starting a second.
    await devices.list(currentProject()?.root, output, target);
    tree.refresh();
  };

  const tree = new DayTree({
    state,
    runner,
    project: currentProject,
    projects: allProjects,
    refreshDevices,
  });
  const view = vscode.window.createTreeView("dayTargets", {
    treeDataProvider: tree,
    showCollapseAll: false,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(view);
  context.subscriptions.push(
    view.onDidChangeCheckboxState(async (e) => {
      for (const [node] of e.items) {
        if (node.kind === "target") {
          // The row names its own project, so ticking a target under one app never reaches another.
          await state.toggleTargetFor(node.root, node.name);
        } else if (node.kind === "config" && node.which === "verbose") {
          // The row's own project, like every other config row — ticking Day-Showcase's Verbose
          // while Day-Rise is focused was flipping Day-Rise's.
          await toggleVerbose(node.root);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => void followEditor(editor),
    ),
  );

  context.subscriptions.push(runner.onDidChange(() => devices.invalidate()));

  const statusBar = new StatusBar(state, runner, currentProject);
  context.subscriptions.push(statusBar);
  // Settings edited through the Settings UI must reflect in the cockpit immediately
  // (e.g. the keep-alive pin on the script item).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("day")) {
        statusBar.update();
        // …and the tree, whose Verbose row reads the setting rather than the selection Memento.
        tree.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      DayTaskProvider.type,
      new DayTaskProvider(state, currentProject, allProjects),
    ),
  );

  // One project's ticked targets that this host can actually build and that belong to it.
  const runnableFor = (project: DayProject): string[] => {
    const declared = project.targets;
    return state.selectionFor(project.root).targets.filter((name) => {
      const target = findTarget(name);
      const okHost = target ? isBuildableHere(target) : true;
      const inProject = declared.length === 0 || declared.includes(name);
      return okHost && inProject;
    });
  };

  /** The focused project's runnable ticks — what the plain Run and Build buttons act on. */
  const selectedRunnable = (): string[] => {
    const project = currentProject();
    return project ? runnableFor(project) : [];
  };

  const requireProject = (): boolean => {
    if (currentProject()) {
      return true;
    }
    vscode.window.showWarningMessage(
      "No Day project (Day.toml) found in this workspace.",
    );
    return false;
  };

  /**
   * The project a configuration row acts on: the one it is drawn under.
   *
   * Invoked from the palette there is no row, so it means the focused project — but a click on
   * Day-Showcase's Build mode must edit Day-Showcase even while Day-Rise is focused, which is the
   * whole reason these rows moved inside their projects.
   */
  const configRoot = (node?: Node): string | undefined =>
    node &&
    (node.kind === "config" || node.kind === "group" || node.kind === "project")
      ? node.root
      : state.focusedRoot;

  // Tree context menus pass a Node, which carries the project the row belongs to; the status-bar
  // tooltip links pass a bare target name, which can only mean the focused project.
  const refOf = (node?: Node | string): RunRef | undefined => {
    if (typeof node === "string") {
      const root = state.focusedRoot;
      return root ? { root, target: node } : undefined;
    }
    return node && node.kind === "target"
      ? { root: node.root, target: node.name }
      : undefined;
  };

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Day: ${err?.message ?? err}`);
    }
  };

  const register = (id: string, fn: (...args: any[]) => any): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register("day.installCli", () => promptToInstall());

  register("day.run", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const targets = selectedRunnable();
      if (targets.length === 0) {
        vscode.window.showInformationMessage(
          "Tick one or more targets in the Day view, then Run.",
        );
        return;
      }
      await runner.runTargets(currentProject()!.root, targets);
    }),
  );

  // The fan-out counterpart of Run: every project's ticked targets, not just the focused one's.
  // Separate from `day.run` rather than a mode of it, so the button that launches one app cannot
  // become the button that launches twenty by way of a setting nobody remembers changing.
  register("day.runAll", () =>
    guard(async () => {
      const work = allProjects()
        .map((project) => ({ project, targets: runnableFor(project) }))
        .filter(({ targets }) => targets.length > 0);
      if (work.length === 0) {
        vscode.window.showInformationMessage(
          "No targets are ticked in any project. Tick some in the Day view, then Run All.",
        );
        return;
      }
      const launches = work.reduce((n, w) => n + w.targets.length, 0);
      for (const { project, targets } of work) {
        await runner.runTargets(project.root, targets);
      }
      vscode.window.setStatusBarMessage(
        `Day: launched ${launches} target(s) across ${work.length} project(s)`,
        4000,
      );
    }),
  );

  register("day.build", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const targets = selectedRunnable();
      if (targets.length === 0) {
        vscode.window.showInformationMessage(
          "Tick one or more targets in the Day view, then Build.",
        );
        return;
      }
      await runner.buildTargets(currentProject()!.root, targets);
    }),
  );

  register("day.runTarget", (node?: Node | string) =>
    guard(async () => {
      const ref = refOf(node);
      if (ref) {
        await runner.runTargets(ref.root, [ref.target]);
      }
    }),
  );

  register("day.stop", (node?: Node | string) =>
    guard(async () => {
      const ref = refOf(node);
      if (ref) {
        await runner.stop(ref.root, ref.target);
      }
    }),
  );

  register("day.restart", (node?: Node | string) =>
    guard(async () => {
      const ref = refOf(node);
      if (ref) {
        await runner.restart(ref.root, ref.target);
      }
    }),
  );

  register("day.stopAll", () => guard(() => runner.stopAll()));

  register("day.toggleVerbose", (node?: Node) =>
    guard(async () => {
      const on = await toggleVerbose(configRoot(node));
      vscode.window.setStatusBarMessage(
        on
          ? "Day: builds and launches will show every sub-command they run"
          : "Day: builds and launches will show Day's status lines only",
        4000,
      );
    }),
  );

  register("day.selectLogLevel", (node?: Node) =>
    guard(async () => {
      const root = configRoot(node);
      const level = await pickLogLevel(logLevel(root));
      if (level) {
        await setLogLevel(level, root);
      }
    }),
  );

  register("day.selectDevice", (node?: Node) =>
    guard(async () => {
      if (!node || node.kind !== "device") {
        return;
      }
      const { root, target } = node;
      devices.invalidate(target); // opening the picker is the moment to re-look at THIS target
      // Handed the PROMISE, not its result: the picker opens on the next frame and spins while
      // the CLI answers, instead of leaving the click with no feedback. The tree row spins for
      // the same reason, since the query is what both are waiting on.
      const listing = devices.list(root, output, target);
      tree.refresh();
      void listing.finally(() => tree.refresh());
      const pick = await pickDevice(
        target,
        listing,
        state.selectionFor(root).devices?.[target],
      );
      if (!pick) {
        return; // cancelled
      }
      if (pick.kind === "boot") {
        // Start it, then pick it — the whole reason booting is offered here is that selecting a
        // shut-down simulator used to dead-end in "boot one yourself".
        const failed = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Day: starting ${pick.name}`,
          },
          () => devices.boot(root, target, pick.id),
        );
        if (failed) {
          vscode.window.showErrorMessage(
            `Day: could not start ${pick.name} — ${failed}`,
          );
          return;
        }
        const started = (
          await devices.list(root, output, target)
        )?.devices.find((d) => d.id === pick.id);
        if (started?.flag) {
          await state.chooseDevice(root, target, {
            id: started.id,
            label: started.name,
            flag: started.flag,
          });
        } else {
          // It is starting but not ready to install onto yet; leave the target on its default
          // rather than pinning a device the next launch would fail against.
          vscode.window.setStatusBarMessage(
            `Day: ${pick.name} is starting — pick it once it finishes booting`,
            5000,
          );
        }
      } else {
        // "All connected" clears the pin; anything else stores the device and its flag.
        await state.chooseDevice(
          root,
          target,
          pick.kind === "all" ? undefined : pick.device,
        );
      }
      tree.refresh();
    }),
  );

  register("day.toggleTarget", (node?: Node | string) =>
    guard(async () => {
      const ref = refOf(node);
      if (ref) {
        await state.toggleTargetFor(ref.root, ref.target);
      }
    }),
  );

  register("day.selectTargets", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const chosen = await pickTargets(
        currentProject(),
        state.selection.targets,
      );
      if (chosen) {
        await state.update({ targets: chosen });
        tree.refresh();
      }
    }),
  );

  register("day.setMode", (mode?: string) =>
    guard(async () => {
      if (mode === "debug" || mode === "release") {
        await state.update({ profile: mode });
      }
    }),
  );

  register("day.setLocale", (locale?: string) =>
    guard(async () => {
      await state.update({ locale: locale ?? "" });
    }),
  );

  register("day.setScript", (script?: string) =>
    guard(async () => {
      await state.update({ script: script ?? "" });
    }),
  );

  register("day.buildTarget", (node?: Node | string) =>
    guard(async () => {
      const ref = refOf(node);
      if (ref) {
        await runner.buildTargets(ref.root, [ref.target]);
      }
    }),
  );

  register("day.selectMode", (node?: Node) =>
    guard(async () => {
      const root = configRoot(node);
      if (!root) {
        return;
      }
      const mode = await pickMode(state.selectionFor(root).profile);
      if (mode) {
        await state.updateFor(root, { profile: mode });
      }
    }),
  );

  register("day.selectLocale", (node?: Node) =>
    guard(async () => {
      const root = configRoot(node);
      const project = projects.find((p) => p.root === root);
      if (!root) {
        return;
      }
      const locale = await pickLocale(project, state.selectionFor(root).locale);
      if (locale !== undefined) {
        await state.updateFor(root, { locale });
      }
    }),
  );

  register("day.selectScript", (node?: Node) =>
    guard(async () => {
      const root = configRoot(node);
      const project = projects.find((p) => p.root === root);
      if (!root) {
        return;
      }
      const script = await pickScript(project, state.selectionFor(root).script);
      if (script !== undefined) {
        await state.updateFor(root, { script });
      }
    }),
  );

  register("day.selectProject", () =>
    guard(async () => {
      await refreshProjects();
      const chosen = await pickProject(projects, state.focusedRoot);
      if (chosen) {
        await state.focus(chosen.root);
      }
    }),
  );

  // Clicking a row in the Projects section, as opposed to the palette's quick pick: the project is
  // already named, so there is nothing to choose.
  register("day.focusProject", (node?: Node) =>
    guard(async () => {
      const root = node && node.kind === "project" ? node.root : undefined;
      if (root) {
        await state.focus(root);
      }
    }),
  );

  /** The project a Projects-section row addresses. */
  const projectOf = (node?: Node): DayProject | undefined =>
    node && node.kind === "project"
      ? projects.find((p) => p.root === node.root)
      : undefined;

  // Run and Stop for ONE project from its own row. Without these, launching an app that is not the
  // focused one means focusing it first — two gestures for what the row is already pointing at.
  register("day.runProject", (node?: Node) =>
    guard(async () => {
      const project = projectOf(node);
      if (!project) {
        return;
      }
      const targets = runnableFor(project);
      if (targets.length === 0) {
        vscode.window.showInformationMessage(
          `Tick one or more targets under ${project.name}, then Run.`,
        );
        return;
      }
      await runner.runTargets(project.root, targets);
    }),
  );

  register("day.stopProject", (node?: Node) =>
    guard(async () => {
      const project = projectOf(node);
      if (!project) {
        return;
      }
      for (const target of runner.runningIn(project.root)) {
        await runner.stop(project.root, target);
      }
    }),
  );

  // Per PROJECT, not per target: every rule reads the project's sources, catalogs and manifest,
  // and none of them is target-specific today. Running it once per ticked target would run the
  // same checks a dozen times and report each finding a dozen times.
  const lintProject = async (root: string): Promise<void> => {
    const counts = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Day: linting" },
      () => lint.run(root),
    );
    if (!counts) {
      vscode.window.showErrorMessage(
        "Day: `day lint` could not run — see the Day output channel.",
      );
      output.show(true);
      return;
    }
    const { errors = 0, warnings = 0, fixable = 0 } = counts;
    if (errors + warnings === 0) {
      vscode.window.setStatusBarMessage(
        `Day: no lint findings in ${path.basename(root)}`,
        4000,
      );
      return;
    }
    const parts = [`${errors} error(s)`, `${warnings} warning(s)`];
    if (fixable > 0) {
      parts.push(`${fixable} fixable`);
    }
    vscode.window.setStatusBarMessage(`Day: ${parts.join(", ")}`, 6000);
    await vscode.commands.executeCommand("workbench.actions.view.problems");
  };

  register("day.lintProject", (node?: Node) =>
    guard(async () => {
      const root = configRoot(node);
      if (!root) {
        vscode.window.showInformationMessage("Open a Day project first.");
        return;
      }
      await lintProject(root);
    }),
  );

  // Runs after a quick fix's edit has been applied. The CLI reads files from DISK, so the buffer
  // has to be saved before re-checking or the next run would report what the fix just removed.
  register("day.relintAfterFix", (uri?: vscode.Uri) =>
    guard(async () => {
      if (!uri) {
        return;
      }
      const root = lint.projectOf(uri);
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString(),
      );
      await document?.save();
      if (root) {
        await lint.run(root);
      }
    }),
  );

  // Every fix is a whole-file rewrite computed from the text as it was, so they cannot be applied
  // together — the second would undo the first. One at a time, re-checking in between, which is
  // what `day lint --fix` does on the command line.
  register("day.fixAllInFile", (uri?: vscode.Uri) =>
    guard(async () => {
      if (!uri) {
        return;
      }
      const root = lint.projectOf(uri);
      let applied = 0;
      for (let pass = 0; pass < 8; pass++) {
        const [fix] = lint.fixesIn(uri);
        if (!fix) {
          break;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (!(await vscode.workspace.applyEdit(editFor(document, fix)))) {
          break;
        }
        await document.save();
        applied += 1;
        if (!root || !(await lint.run(root))) {
          break;
        }
      }
      vscode.window.setStatusBarMessage(
        applied > 0
          ? `Day: applied ${applied} lint fix(es) to ${path.basename(uri.fsPath)}`
          : "Day: nothing here has a fix that can be applied unattended",
        4000,
      );
    }),
  );

  register("day.doctor", () =>
    guard(async () => {
      const cli = resolveCli(currentProject()?.root);
      // The toolchain settings go in explicitly: a terminal otherwise inherits the login
      // environment, and doctor would report on whichever SDK that names rather than the one
      // every build here will actually use.
      const term = vscode.window.createTerminal({
        name: "day doctor",
        cwd: cli.cwd,
        env: toolchainEnv(),
      });
      term.show(true);
      term.sendText(renderCommand(cli, ["doctor"]));
    }),
  );

  register("day.refresh", () =>
    guard(async () => {
      await refreshProjects();
      tree.refresh();
    }),
  );

  register("day.openSettings", () =>
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:daybrite.day-vscode",
    ),
  );

  register("day.showLog", () => output.show(true));

  register("day.toggleScriptKeepAlive", () =>
    guard(async () => {
      const cfg = vscode.workspace.getConfiguration("day");
      const current = cfg.get<boolean>("script.keepAppRunning", true);
      // Flip at the scope that currently supplies the value, so a workspace override stays a
      // workspace override and everything else lands in user settings.
      const info = cfg.inspect<boolean>("script.keepAppRunning");
      const target =
        info?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await cfg.update("script.keepAppRunning", !current, target);
      statusBar.update();
      vscode.window.setStatusBarMessage(
        !current
          ? "Day: apps will stay running after a dayscript completes"
          : "Day: apps will terminate when their dayscript completes",
        4000,
      );
    }),
  );

  // The walkthrough itself is declarative (package.json `contributes.walkthroughs`), so VS Code
  // shows it on the Welcome page WITHOUT activating this extension — which is what a person with
  // no Day project yet will actually see. This command is the way back to it afterwards.
  /**
   * Open what was just scaffolded, the way the user wants it opened.
   *
   * Asking every time gets old by the third piece, so the answer is a setting with an `ask`
   * default — the same shape rust-analyzer settled on.
   */
  const openCreated = async (created: vscode.Uri, name: string): Promise<void> => {
    const configured = vscode.workspace
      .getConfiguration("day")
      .get<string>("newProject.openAfterCreate", "ask");
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
    let action = configured;
    if (action === "ask") {
      const choice = await vscode.window.showInformationMessage(
        `Created ${name}. Open it?`,
        { modal: true },
        "Open",
        "Open in New Window",
        ...(hasWorkspace ? ["Add to Workspace"] : []),
      );
      if (!choice) {
        return; // created and left alone, which is a legitimate answer
      }
      action =
        choice === "Open"
          ? "open"
          : choice === "Open in New Window"
            ? "openNewWindow"
            : "addToWorkspace";
    }
    if (action === "addToWorkspace" && hasWorkspace) {
      vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        null,
        { uri: created },
      );
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", created, {
      forceNewWindow: action !== "open",
    });
  };

  register("day.openWalkthrough", () =>
    vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#welcome`,
      false,
    ),
  );

  register("day.newProject", () =>
    guard(async () => {
      // Every question comes from `day new --describe`, so this command never has to know what a
      // target is called or which toolkits a native piece can have.
      const spec = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Day: reading the project options" },
        () => describeSpec(output),
      );
      if (!spec) {
        vscode.window.showErrorMessage(
          "Day: this `day` CLI cannot describe its project options — it predates `day new --describe`. Update it, then try again.",
        );
        output.show(true);
        return;
      }

      const asked = await askAll(spec);
      if (!asked) {
        return; // escaped, at any step
      }
      const { kind, answers } = asked;
      const name = String(answers.name ?? "").trim();

      const dir = await vscode.window.showOpenDialog({
        title: `Day: New ${kind.label} — parent folder`,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Create Here",
      });
      if (!dir?.[0]) {
        return;
      }
      const parent = dir[0].fsPath;

      const cli = resolveCli();
      const args = [...cli.baseArgs, ...composeArgs(kind, answers)];
      output.appendLine(`> ${renderCommand(cli, args.slice(cli.baseArgs.length))}`);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Scaffolding ${name}…`,
        },
        () =>
          new Promise<void>((resolve, reject) => {
            childProcess.execFile(
              cli.command,
              args,
              // The folder the user PICKED, always. `day new` creates ./<name> under its cwd, and
              // `cli.cwd` is the day checkout under `day.cliSource` — so honouring that put the
              // new project inside the day repo and ignored the dialog entirely.
              { cwd: parent, env: { ...process.env, ...toolchainEnv() } },
              (err, _out, stderr) => {
                if (err) {
                  reject(new Error(stderr || err.message));
                } else {
                  resolve();
                }
              },
            );
          }),
      );

      const created = vscode.Uri.file(path.join(parent, name));
      await openCreated(created, name);
    }),
  );

  // Expose Day to agents over MCP (VS Code 1.101+): the server is the day CLI itself, so any
  // MCP client gets the same tools. Guarded — older VS Code simply skips it.
  const lmAny = (vscode as any).lm;
  if (typeof lmAny?.registerMcpServerDefinitionProvider === "function") {
    context.subscriptions.push(
      lmAny.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        provideMcpServerDefinitions: async () => {
          const spec = mcpServerSpec(currentProject()?.root);
          const DefCtor = (vscode as any).McpStdioServerDefinition;
          if (!spec || typeof DefCtor !== "function") {
            return [];
          }
          const def = new DefCtor("Day", spec.command, spec.args, {});
          if (spec.cwd) {
            def.cwd = vscode.Uri.file(spec.cwd);
          }
          return [def];
        },
      }),
    );
  }

  // Native Run and Debug (View → Run, F5): the `day` debug type resolves the cockpit's selection,
  // then either delegates a desktop target to an installed Rust debugger (real breakpoints — see
  // debug.ts `delegate`) or launches through the same `day launch` path as the Run button, with a
  // launch-only inline adapter streaming the app's console into the Debug Console.
  const debugProvider = new DayConfigProvider({
    project: currentProject,
    selection: () => state.selection,
    runnableTargets: selectedRunnable,
    keepAliveDefault: () =>
      vscode.workspace
        .getConfiguration("day")
        .get<boolean>("script.keepAppRunning", true),
    // The debug session names its own project (DayLaunchConfig.project); an F5 with no project in
    // launch.json means the focused one, which is what resolveDebugConfiguration filled in.
    stopIfRunning: async (root, target) => {
      if (runner.isRunning(root, target)) {
        await runner.stop(root, target);
      }
    },
    output,
  });
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("day", debugProvider),
    vscode.debug.registerDebugConfigurationProvider(
      "day",
      debugProvider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "day",
      new DayDebugAdapterFactory(),
    ),
  );

  // Re-scan when a Day.toml appears/changes/disappears.
  const watcher = vscode.workspace.createFileSystemWatcher("**/Day.toml");
  const rescan = () =>
    guard(async () => {
      await refreshProjects();
      tree.refresh();
    });
  watcher.onDidCreate(rescan);
  watcher.onDidChange(rescan);
  watcher.onDidDelete(rescan);
  context.subscriptions.push(watcher);

  tree.refresh();
  return { focusedProject: () => state.focusedRoot };
}

export function deactivate(): void {
  /* the Runner and status bar are disposed via context.subscriptions */
}
