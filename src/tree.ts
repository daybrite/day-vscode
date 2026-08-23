// The Day sidebar tree: a Projects section listing every Day app in the window, each expanding to
// its own targets (checkboxes, running badges, inline run/stop/restart), and a Configuration section
// for the focused project's build mode / locale / dayscript / verbose / log level.
//
// Every project is present at once rather than one at a time, because a window can hold dozens of
// apps and the point is to see and drive them together. Targets belong to a project — the row
// carries its root — so ticking `ios-uikit` under one app says nothing about the next.

import * as path from "path";
import * as vscode from "vscode";

import { State } from "./config";
import { logLevel, verbose } from "./tasks";
import { DayProject } from "./project";
import { Runner } from "./runner";
import { catalog, findTarget, isBuildableHere, kindLabel } from "./targets";

export type Node =
  | { kind: "section"; id: "projects" | "config"; label: string }
  | { kind: "project"; root: string }
  | { kind: "config"; which: "mode" | "locale" | "script" | "verbose" | "loglevel" }
  | { kind: "target"; root: string; name: string };

export interface TreeDeps {
  state: State;
  runner: Runner;
  /** The focused project — what the Configuration rows and the plain Run button act on. */
  project: () => DayProject | undefined;
  /** Every discovered project, in the order the sidebar should list them. */
  projects: () => DayProject[];
}

export class DayTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: TreeDeps) {
    deps.state.onDidChange(() => this.refresh());
    deps.runner.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** The targets a project offers: the ones it declares, else the whole catalog. */
  private targetNames(project: DayProject): string[] {
    return project.targets.length > 0 ? project.targets : catalog().map((t) => t.name);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      const projects = this.deps.projects();
      if (projects.length === 0) {
        return []; // triggers the viewsWelcome content
      }
      const focused = this.deps.project();
      const nodes: Node[] = [{ kind: "section", id: "projects", label: "Projects" }];
      if (focused) {
        // Named in the header, because with several projects open "Build mode: release" is
        // ambiguous otherwise — these rows only ever act on the focused one.
        nodes.push({ kind: "section", id: "config", label: `Configuration — ${focused.name}` });
      }
      return nodes;
    }
    if (element.kind === "section" && element.id === "projects") {
      return this.deps.projects().map((p) => ({ kind: "project", root: p.root }) as Node);
    }
    if (element.kind === "section" && element.id === "config") {
      return [
        { kind: "config", which: "mode" },
        { kind: "config", which: "locale" },
        { kind: "config", which: "script" },
        { kind: "config", which: "verbose" },
        { kind: "config", which: "loglevel" },
      ];
    }
    if (element.kind === "project") {
      const project = this.deps.projects().find((p) => p.root === element.root);
      return project
        ? this.targetNames(project).map((name) => ({ kind: "target", root: project.root, name }) as Node)
        : [];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "section":
        return this.sectionItem(node);
      case "project":
        return this.projectItem(node.root);
      case "config":
        return this.configItem(node.which);
      case "target":
        return this.targetItem(node.root, node.name);
    }
  }

  private sectionItem(node: { id: string; label: string }): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `section:${node.id}`;
    item.contextValue = "daySection";
    return item;
  }

  private projectItem(root: string): vscode.TreeItem {
    const p = this.deps.projects().find((x) => x.root === root);
    const focused = this.deps.project()?.root === root;
    const label = p?.name ?? path.basename(root);
    // Only the focused project opens expanded by default. With dozens of apps, expanding them all
    // would bury the tree; VS Code remembers what the user expands itself, because `id` is stable.
    const item = new vscode.TreeItem(
      label,
      focused ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `project:${root}`;
    const running = this.deps.runner.runningIn(root).length;
    const bits: string[] = [];
    if (focused) {
      bits.push("focused");
    }
    if (running > 0) {
      bits.push(`${running} running`);
    }
    item.description = bits.join(" · ");
    item.tooltip = new vscode.MarkdownString(
      `**${p?.title ?? label}**\n\n\`${p?.id ?? ""}\`\n\n${root}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      running > 0 ? "play-circle" : "package",
      running > 0 ? new vscode.ThemeColor("charts.green") : undefined,
    );
    // `dayProjectFocused` vs `dayProject` so the context menu can offer "Focus" only where it does
    // something. Both stay projects for the menus that apply to either.
    item.contextValue = focused ? "dayProjectFocused" : "dayProject";
    item.command = {
      command: "day.focusProject",
      title: "Focus Project",
      arguments: [{ kind: "project", root } as Node],
    };
    return item;
  }

  private configItem(
    which: "mode" | "locale" | "script" | "verbose" | "loglevel",
  ): vscode.TreeItem {
    // A checkbox rather than a pick: it is one bit, and the rows below all open a quick pick
    // because they choose among values. Checked state comes from the SETTING (`day.verbose`),
    // not the per-workspace selection Memento, so the Settings UI and this row are one control.
    if (which === "verbose") {
      const on = verbose(this.deps.project()?.root);
      const item = new vscode.TreeItem("Verbose", vscode.TreeItemCollapsibleState.None);
      item.id = "config:verbose";
      item.description = on ? "on" : "off";
      item.tooltip =
        "Run builds and launches with `--verbose`, showing every sub-command they execute " +
        "(cargo, gradle, xcodebuild, hvigor, adb, …) and its raw output.";
      item.iconPath = new vscode.ThemeIcon("output");
      item.contextValue = "dayConfig";
      item.checkboxState = on
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      // Clicking the LABEL toggles too — the checkbox is a small target, and every other row in
      // this section acts on a plain click.
      item.command = { command: "day.toggleVerbose", title: "Toggle Verbose" };
      return item;
    }
    const sel = this.deps.state.selection;
    let label: string;
    let value: string;
    let icon: string;
    let command: string;
    switch (which) {
      case "mode":
        label = "Build mode";
        value = sel.profile;
        icon = "gear";
        command = "day.selectMode";
        break;
      case "locale":
        label = "Locale";
        value = sel.locale.length > 0 ? sel.locale : "(default)";
        icon = "globe";
        command = "day.selectLocale";
        break;
      case "script":
        label = "Dayscript";
        value = sel.script.length > 0 ? path.basename(sel.script) : "(none)";
        icon = "play-circle";
        command = "day.selectScript";
        break;
      case "loglevel":
        // From the SETTING (`day.logLevel`), like the Verbose row — the Settings UI and this
        // row are one control.
        label = "Log level";
        value = logLevel(this.deps.project()?.root);
        icon = "list-filter";
        command = "day.selectLogLevel";
        break;
    }
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `config:${which}`;
    item.description = value;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = "dayConfig";
    item.command = { command, title: label };
    return item;
  }

  private targetItem(root: string, name: string): vscode.TreeItem {
    const target = findTarget(name);
    const running = this.deps.runner.isRunning(root, name);
    const buildable = target ? isBuildableHere(target) : true;
    const selected = this.deps.state.selectionFor(root).targets.includes(name);

    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = `target:${root}:${name}`;

    const parts: string[] = [];
    if (target) {
      parts.push(kindLabel(target));
    }
    if (running) {
      parts.push("running");
    } else if (!buildable) {
      parts.push(`needs a ${target?.host} host`);
    }
    item.description = parts.join(" · ");

    if (running) {
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
      item.contextValue = "dayTargetRunning";
    } else if (!buildable) {
      item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      item.contextValue = "dayTargetDisabled";
    } else {
      const kindIcon = target && target.kind === "desktop" ? "device-desktop" : "device-mobile";
      item.iconPath = new vscode.ThemeIcon(kindIcon);
      item.contextValue = "dayTarget";
    }

    // Only buildable targets get a selection checkbox + a toggle-on-click.
    if (buildable) {
      item.checkboxState = selected
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      item.command = {
        command: "day.toggleTarget",
        title: "Toggle Target",
        arguments: [{ kind: "target", root, name } as Node],
      };
    }
    item.tooltip = target
      ? `${name} — ${kindLabel(target)}${buildable ? "" : ` (requires a ${target.host} host)`}`
      : name;
    return item;
  }
}
