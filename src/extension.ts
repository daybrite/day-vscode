// Day extension entry point: discovers Day.toml projects, wires the sidebar tree, status bar, task
// provider, and commands, and drives build/run/stop/restart through the Runner (Tasks API).

import * as childProcess from "child_process";
import * as path from "path";
import * as vscode from "vscode";

import { renderCommand, resolveCli } from "./cli";
import { State } from "./config";
import { DayProject, findProjects } from "./project";
import { pickLocale, pickMode, pickProject, pickScript, pickTargets } from "./quickpicks";
import { Runner } from "./runner";
import { StatusBar } from "./statusbar";
import { DayTaskProvider } from "./taskProvider";
import { findTarget, isBuildableHere } from "./targets";
import { DayTree, Node } from "./tree";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new State(context.workspaceState);
  const runner = new Runner(state);
  context.subscriptions.push(runner);

  let projects: DayProject[] = [];

  const currentProject = (): DayProject | undefined => {
    const root = state.selection.projectRoot;
    return projects.find((p) => p.root === root) ?? projects[0];
  };

  const refreshProjects = async (): Promise<void> => {
    projects = await findProjects();
    const root = state.selection.projectRoot;
    if ((!root || !projects.find((p) => p.root === root)) && projects.length > 0) {
      await state.update({ projectRoot: projects[0].root });
    }
  };

  await refreshProjects();

  const tree = new DayTree({ state, runner, project: currentProject });
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
          await state.toggleTarget(node.name);
        }
      }
    }),
  );

  const statusBar = new StatusBar(state, runner, currentProject);
  context.subscriptions.push(statusBar);
  // Settings edited through the Settings UI must reflect in the cockpit immediately
  // (e.g. the keep-alive pin on the script item).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("day")) {
        statusBar.update();
      }
    }),
  );

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(DayTaskProvider.type, new DayTaskProvider(state, currentProject)),
  );

  // The user's selected targets that this host can actually build and that belong to the project.
  const selectedRunnable = (): string[] => {
    const declared = currentProject()?.targets ?? [];
    return state.selection.targets.filter((name) => {
      const target = findTarget(name);
      const okHost = target ? isBuildableHere(target) : true;
      const inProject = declared.length === 0 || declared.includes(name);
      return okHost && inProject;
    });
  };

  const requireProject = (): boolean => {
    if (currentProject()) {
      return true;
    }
    vscode.window.showWarningMessage("No Day project (Day.toml) found in this workspace.");
    return false;
  };

  // Tree context menus pass a Node; the status-bar tooltip links pass a plain target name.
  const targetOf = (node?: Node | string): string | undefined =>
    typeof node === "string" ? node : node && node.kind === "target" ? node.name : undefined;

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

  register("day.run", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const targets = selectedRunnable();
      if (targets.length === 0) {
        vscode.window.showInformationMessage("Tick one or more targets in the Day view, then Run.");
        return;
      }
      await runner.runTargets(targets);
    }),
  );

  register("day.build", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const targets = selectedRunnable();
      if (targets.length === 0) {
        vscode.window.showInformationMessage("Tick one or more targets in the Day view, then Build.");
        return;
      }
      await runner.buildTargets(targets);
    }),
  );

  register("day.runTarget", (node?: Node | string) =>
    guard(async () => {
      const name = targetOf(node);
      if (name) {
        await runner.runTargets([name]);
      }
    }),
  );

  register("day.stop", (node?: Node | string) =>
    guard(async () => {
      const name = targetOf(node);
      if (name) {
        await runner.stop(name);
      }
    }),
  );

  register("day.restart", (node?: Node | string) =>
    guard(async () => {
      const name = targetOf(node);
      if (name) {
        await runner.restart(name);
      }
    }),
  );

  register("day.stopAll", () => guard(() => runner.stopAll()));

  register("day.toggleTarget", (node?: Node | string) =>
    guard(async () => {
      const name = targetOf(node);
      if (name) {
        await state.toggleTarget(name);
      }
    }),
  );

  register("day.selectTargets", () =>
    guard(async () => {
      if (!requireProject()) {
        return;
      }
      const chosen = await pickTargets(currentProject(), state.selection.targets);
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
      const name = targetOf(node);
      if (name) {
        await runner.buildTargets([name]);
      }
    }),
  );

  register("day.selectMode", () =>
    guard(async () => {
      const mode = await pickMode(state.selection.profile);
      if (mode) {
        await state.update({ profile: mode });
      }
    }),
  );

  register("day.selectLocale", () =>
    guard(async () => {
      const locale = await pickLocale(currentProject(), state.selection.locale);
      if (locale !== undefined) {
        await state.update({ locale });
      }
    }),
  );

  register("day.selectScript", () =>
    guard(async () => {
      const script = await pickScript(currentProject(), state.selection.script);
      if (script !== undefined) {
        await state.update({ script });
      }
    }),
  );

  register("day.selectProject", () =>
    guard(async () => {
      await refreshProjects();
      const chosen = await pickProject(projects, state.selection.projectRoot);
      if (chosen) {
        await state.update({ projectRoot: chosen.root });
      }
    }),
  );

  register("day.doctor", () =>
    guard(async () => {
      const cli = resolveCli(currentProject()?.root);
      const term = vscode.window.createTerminal({ name: "day doctor", cwd: cli.cwd });
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
    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:daybrite.day-vscode"),
  );

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

  register("day.newProject", () =>
    guard(async () => {
      const name = await vscode.window.showInputBox({
        title: "Day: New Project (1/3) — name",
        prompt: "Crate name for the new app",
        placeHolder: "my-app",
        validateInput: (v) => (/^[a-z][a-z0-9_-]*$/.test(v) ? undefined : "lowercase letters, digits, - or _"),
      });
      if (!name) {
        return;
      }
      const toolkits = await vscode.window.showQuickPick(
        [
          { label: "macos-appkit", description: "macOS · AppKit" },
          { label: "ios-uikit", description: "iOS · UIKit" },
          { label: "android-widget", description: "Android · native widgets" },
          { label: "linux-gtk", description: "Linux · GTK 4" },
          { label: "linux-qt", description: "Linux · Qt 6" },
          { label: "windows-winui", description: "Windows · WinUI" },
          { label: "ohos-arkui", description: "HarmonyOS · ArkUI" },
        ],
        { title: "Day: New Project (2/3) — targets", canPickMany: true, placeHolder: "Pick the platform-toolkits to scaffold" },
      );
      if (!toolkits || toolkits.length === 0) {
        return;
      }
      const dir = await vscode.window.showOpenDialog({
        title: "Day: New Project (3/3) — parent folder",
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
      const args = [
        ...cli.baseArgs,
        "new", "app", name,
        "--toolkit", toolkits.map((t) => t.label).join(","),
        "--no-input",
      ];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Scaffolding ${name}…` },
        () =>
          new Promise<void>((resolve, reject) => {
            childProcess.execFile(cli.command, args, { cwd: cli.cwd ?? parent, env: process.env }, (err, _out, stderr) => {
              if (err) {
                reject(new Error(stderr || err.message));
              } else {
                resolve();
              }
            });
          }),
      );
      // The cargo fallback runs in the day repo cwd; the plain CLI runs in the parent folder.
      // `day new` always creates ./<name> under its cwd.
      const created = vscode.Uri.file(path.join(cli.cwd ?? parent, name));
      await vscode.commands.executeCommand("vscode.openFolder", created, { forceNewWindow: true });
    }),
  );

  // Expose Day to agents over MCP (VS Code 1.101+): the server is the day CLI itself, so any
  // MCP client gets the same tools. Guarded — older VS Code simply skips it.
  const lmAny = (vscode as any).lm;
  if (typeof lmAny?.registerMcpServerDefinitionProvider === "function") {
    context.subscriptions.push(
      lmAny.registerMcpServerDefinitionProvider("day", {
        provideMcpServerDefinitions: async () => {
          if (!vscode.workspace.getConfiguration("day").get<boolean>("mcp.enabled", true)) {
            return [];
          }
          const project = currentProject();
          if (!project) {
            return [];
          }
          const cli = resolveCli(project.root);
          const DefCtor = (vscode as any).McpStdioServerDefinition;
          if (typeof DefCtor !== "function") {
            return [];
          }
          const def = new DefCtor(
            "Day",
            cli.command,
            [...cli.baseArgs, "--project", project.root, "mcp-server"],
            {},
          );
          if (cli.cwd) {
            def.cwd = vscode.Uri.file(cli.cwd);
          }
          return [def];
        },
      }),
    );
  }

  // Re-scan when a Day.toml appears/changes/disappears.
  const watcher = vscode.workspace.createFileSystemWatcher("**/Day.toml");
  const rescan = () => guard(async () => {
    await refreshProjects();
    tree.refresh();
  });
  watcher.onDidCreate(rescan);
  watcher.onDidChange(rescan);
  watcher.onDidDelete(rescan);
  context.subscriptions.push(watcher);

  tree.refresh();
}

export function deactivate(): void {
  /* the Runner and status bar are disposed via context.subscriptions */
}
