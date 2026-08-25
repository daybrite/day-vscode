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
import { cached, isMobile, loading } from "./devices";
import { logLevel, verbose } from "./tasks";
import { DayProject } from "./project";
import { Runner } from "./runner";
import { catalog, findTarget, isBuildableHere, kindLabel } from "./targets";

/** Which configuration row a `config` node is. */
export type ConfigRow = "mode" | "locale" | "script" | "verbose" | "loglevel";

/**
 * Every node below the roots names the project it belongs to. That is what lets a row act on the
 * app it is drawn under rather than on whichever project happens to be focused — with a dozen
 * apps open, a Configuration row that edited someone else's would be indistinguishable from a bug.
 */
export type Node =
  | { kind: "project"; root: string }
  | { kind: "group"; root: string; id: "config" | "targets"; label: string }
  | { kind: "config"; root: string; which: ConfigRow }
  | { kind: "target"; root: string; name: string }
  | { kind: "device"; root: string; target: string };

export interface TreeDeps {
  state: State;
  runner: Runner;
  /** The focused project — what the Configuration rows and the plain Run button act on. */
  project: () => DayProject | undefined;
  /** Every discovered project, in the order the sidebar should list them. */
  projects: () => DayProject[];
  /** Enumerate ONE target's devices and refresh the tree when the answer lands. Per target, so
   *  drawing the iOS row never runs adb. */
  refreshDevices: (target: string) => Promise<void>;
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
    // Projects ARE the roots: a "Projects" wrapper stopped earning its level once each project
    // grew a subtree of its own, and dropping it keeps the deepest row four deep instead of five.
    if (!element) {
      return this.deps.projects().map((p) => ({ kind: "project", root: p.root }) as Node);
    }
    if (element.kind === "project") {
      return [
        { kind: "group", root: element.root, id: "config", label: "Configuration" },
        { kind: "group", root: element.root, id: "targets", label: "Targets" },
      ];
    }
    if (element.kind === "group" && element.id === "config") {
      const rows: ConfigRow[] = ["mode", "locale", "script", "verbose", "loglevel"];
      return rows.map((which) => ({ kind: "config", root: element.root, which }) as Node);
    }
    if (element.kind === "target") {
      // Only mobile targets have a device to choose. Desktop and web have nowhere else to run, so
      // giving them a twisty would promise a choice that does not exist.
      const kind = findTarget(element.name)?.kind;
      return isMobile(kind) ? [{ kind: "device", root: element.root, target: element.name }] : [];
    }
    if (element.kind === "group" && element.id === "targets") {
      const project = this.deps.projects().find((p) => p.root === element.root);
      return project
        ? this.targetNames(project).map(
            (name) => ({ kind: "target", root: project.root, name }) as Node,
          )
        : [];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "project":
        return this.projectItem(node.root);
      case "group":
        return this.groupItem(node);
      case "config":
        return this.configItem(node.root, node.which);
      case "target":
        return this.targetItem(node.root, node.name);
      case "device":
        return this.deviceItem(node.root, node.target);
    }
  }

  /**
   * A project's `Configuration` or `Targets` heading.
   *
   * Both carry a summary on the row itself — the mode and locale a run will use, how many targets
   * are ticked — so a collapsed project still says what pressing Run would do. Only Targets opens
   * by default: the configuration is usually set once and then read off the summary.
   */
  private groupItem(node: { root: string; id: "config" | "targets"; label: string }): vscode.TreeItem {
    const open =
      node.id === "targets"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(node.label, open);
    item.id = `group:${node.root}:${node.id}`;
    item.contextValue = `dayGroup-${node.id}`;
    const sel = this.deps.state.selectionFor(node.root);
    if (node.id === "config") {
      const bits: string[] = [sel.profile];
      if (sel.locale) {
        bits.push(sel.locale);
      }
      if (sel.script) {
        bits.push(path.basename(sel.script));
      }
      item.description = bits.join(" · ");
    } else {
      const running = this.deps.runner.runningIn(node.root).length;
      const ticked = sel.targets.length;
      const bits: string[] = [];
      if (ticked > 0) {
        bits.push(`${ticked} ticked`);
      }
      if (running > 0) {
        bits.push(`${running} running`);
      }
      item.description = bits.join(" · ");
    }
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

  private configItem(root: string, which: ConfigRow): vscode.TreeItem {
    // A checkbox rather than a pick: it is one bit, and the rows below all open a quick pick
    // because they choose among values. Checked state comes from the SETTING (`day.verbose`),
    // not the per-workspace selection Memento, so the Settings UI and this row are one control.
    if (which === "verbose") {
      const on = verbose(root);
      const item = new vscode.TreeItem("Verbose", vscode.TreeItemCollapsibleState.None);
      item.id = `config:${root}:verbose`;
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
      item.command = {
        command: "day.toggleVerbose",
        title: "Toggle Verbose",
        arguments: [{ kind: "config", root, which } as Node],
      };
      return item;
    }
    const sel = this.deps.state.selectionFor(root);
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
        value = logLevel(root);
        icon = "list-filter";
        command = "day.selectLogLevel";
        break;
    }
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `config:${root}:${which}`;
    item.description = value;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = "dayConfig";
    // The row passes its own project, so editing Day-Showcase's mode from its own subtree never
    // reaches into whichever project happens to be focused.
    item.command = { command, title: label, arguments: [{ kind: "config", root, which } as Node] };
    return item;
  }

  /**
   * The Device row under a mobile target.
   *
   * Renders from the CACHED listing and kicks off a refresh when there is none — `getTreeItem` is
   * synchronous, and blocking the sidebar on adb would make every expand feel broken. The refresh
   * fires a tree change when it lands, so the row fills itself in a moment later.
   */
  private deviceItem(root: string, target: string): vscode.TreeItem {
    const chosen = this.deps.state.selectionFor(root).devices?.[target];
    const item = new vscode.TreeItem("Device", vscode.TreeItemCollapsibleState.None);
    item.id = `device:${root}:${target}`;
    item.iconPath = new vscode.ThemeIcon("device-mobile");
    item.contextValue = "dayDevice";
    item.command = {
      command: "day.selectDevice",
      title: "Select Device",
      arguments: [{ kind: "device", root, target } as Node],
    };

    // A query in flight spins the row — the click that opens the picker starts one, and this is
    // the other place the wait is visible. A already-chosen device keeps its label while the
    // spinner runs, so re-querying never looks like the choice was lost.
    const busy = loading(target);
    if (busy) {
      item.iconPath = new vscode.ThemeIcon("sync~spin");
    }
    if (chosen) {
      item.description = busy ? `${chosen.label} · checking…` : chosen.label;
      item.tooltip = `${chosen.label}\n${chosen.flag} ${chosen.id}`;
      return item;
    }
    if (busy) {
      item.description = "looking for devices…";
      item.tooltip = "Asking simctl, adb and hdc what is connected";
      return item;
    }
    const listing = cached(target);
    if (!listing) {
      item.description = "…";
      item.tooltip = "Looking for connected devices";
      void this.deps.refreshDevices(target);
      return item;
    }
    if (!listing.available) {
      item.description = "unavailable";
      item.tooltip = listing.note ?? "this target's toolchain was not found";
      item.iconPath = new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground"),
      );
      return item;
    }
    const n = listing.devices.length;
    item.description = n === 0 ? "none connected" : `all connected (${n})`;
    item.tooltip =
      n === 0
        ? "Nothing is connected for this target"
        : `Launches on every connected device:\n${listing.devices.map((d) => d.name).join("\n")}`;
    return item;
  }

  private targetItem(root: string, name: string): vscode.TreeItem {
    const target = findTarget(name);
    const running = this.deps.runner.isRunning(root, name);
    const buildable = target ? isBuildableHere(target) : true;
    const selected = this.deps.state.selectionFor(root).targets.includes(name);

    const item = new vscode.TreeItem(
      name,
      isMobile(target?.kind)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
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

    // Only buildable targets get a selection checkbox — a target this host cannot build has
    // nothing to tick. Deliberately NO `item.command`: the checkbox is the only thing that
    // toggles, so clicking the row selects it the way every other checkbox tree in VS Code
    // behaves. Binding the whole row to the toggle meant a row could not be selected, expanded,
    // or right-clicked without also flipping whether it builds.
    if (buildable) {
      item.checkboxState = selected
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    item.tooltip = target
      ? `${name} — ${kindLabel(target)}${buildable ? "" : ` (requires a ${target.host} host)`}`
      : name;
    return item;
  }
}
