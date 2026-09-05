// The Day sidebar tree: a Projects section listing every Day app in the window, each expanding to
// its own targets (checkboxes, running badges, inline run/stop/restart), and a Configuration section
// for the focused project's build mode / locale / dayscript / verbose / log level.
//
// Every project is present at once rather than one at a time, because a window can hold dozens of
// apps and the point is to see and drive them together. Targets belong to a project — the row
// carries its root — so ticking `ios-uikit` under one app says nothing about the next.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { State } from "./config";
import {
  cached,
  isMobile,
  liveDevice,
  loading,
  Pending,
  pending,
  TargetDevices,
  virtualDevice,
} from "./devices";
import { CliVersions, isNewer } from "./install";
import { hideUnavailableTargets, logLevel, verbose } from "./tasks";
import { DayProject } from "./project";
import { Runner } from "./runner";
import {
  catalog,
  findTarget,
  isBuildableHere,
  kindLabel,
  nativeProjectFor,
} from "./targets";

/** Which configuration row a `config` node is. */
export type ConfigRow = "mode" | "locale" | "script" | "verbose" | "loglevel";

/**
 * Every node below the roots names the project it belongs to. That is what lets a row act on the
 * app it is drawn under rather than on whichever project happens to be focused — with a dozen
 * apps open, a Configuration row that edited someone else's would be indistinguishable from a bug.
 */
export type Node =
  /** The `day` CLI this window is driving — one row, above the projects it acts on. */
  | { kind: "cli" }
  | { kind: "project"; root: string }
  | { kind: "group"; root: string; id: "config" | "targets"; label: string }
  | { kind: "config"; root: string; which: ConfigRow }
  | { kind: "target"; root: string; name: string }
  /** One configured device under a mobile target. `id` is the device the CLI reported. */
  | { kind: "device"; root: string; target: string; id: string };

export interface TreeDeps {
  state: State;
  runner: Runner;
  /** The focused project — what the Configuration rows and the plain Run button act on. */
  project: () => DayProject | undefined;
  /** Every discovered project, in the order the sidebar should list them. */
  projects: () => DayProject[];
  /** Enumerate ONE target's devices and refresh the tree when the answer lands. Per target, so
   *  drawing the iOS row never runs adb; the row's own project, so the CLI resolves from the app
   *  the row sits under rather than from whichever one happens to be focused. */
  refreshDevices: (root: string, target: string) => Promise<void>;
  /** What is known about the CLI: the version it reports, and the newest release. Both may be
   *  absent — no CLI on this machine, or no answer from the network — and the row says which. */
  versions: () => CliVersions;
}

/**
 * The `day` CLI row: which one is being driven, and whether a newer release exists.
 *
 * A free function because this is the one row with no project behind it — it renders from two
 * strings — and because it is the whole of what the walkthrough could not say. The walkthrough can
 * only be TOLD there is an update (a `when` clause on a context key); its text is fixed in
 * package.json, so the versions themselves have to be shown somewhere that renders at runtime.
 * This is that place.
 */
export function cliItem(v: CliVersions): vscode.TreeItem {
  const stale = !!v.installed && !!v.latest && isNewer(v.installed, v.latest);
  const label = v.installed ? `day ${v.installed}` : "day CLI";
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = "cli";
  if (!v.installed) {
    item.description = "not installed";
    item.iconPath = new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("list.warningForeground"),
    );
    item.tooltip =
      "No `day` CLI could be run. Every build, launch and check goes through it — install one to " +
      "start.";
  } else if (stale) {
    item.description = `update to ${v.latest}`;
    item.iconPath = new vscode.ThemeIcon(
      "arrow-circle-up",
      new vscode.ThemeColor("charts.blue"),
    );
    item.tooltip = `day ${v.installed} is installed; ${v.latest} is the newest release on crates.io.`;
  } else {
    item.description = v.latest ? "up to date" : undefined;
    item.iconPath = new vscode.ThemeIcon("terminal");
    item.tooltip = v.latest
      ? `day ${v.installed}, the newest release on crates.io.`
      : `day ${v.installed}. The newest release could not be checked.`;
  }
  // Clicking it does the thing the row is about; the context value lets the menus offer it too.
  item.contextValue = stale ? "dayCliOutdated" : "dayCli";
  item.command = {
    command: "day.installCli",
    title: "Install/Update the Day CLI",
    arguments: [],
  };
  return item;
}

/**
 * A target row's context value: its state, plus the IDE of any native project it carries.
 *
 * The suffix (`.studio`, `.xcode`) is what puts "Open in Android Studio" / "Open in Xcode" on the
 * row's menu, and it rides on ALL THREE base states — a running or unbuildable row keeps the entry,
 * because opening a project in its IDE has nothing to do with whether this host can build it, and
 * an unbuildable target is exactly when someone reaches for Studio. Every other target menu matches
 * its base with the suffix optional, so adding one here does not take Run or Stop off the row.
 *
 * Checked against disk rather than assumed from the target name: a project that never scaffolded
 * that platform, or that has since deleted it, offers nothing to open.
 */
export function targetContextValue(
  base: string,
  root: string,
  target: string,
  platform: NodeJS.Platform,
): string {
  const native = nativeProjectFor(target, platform);
  return native && fs.existsSync(path.join(root, native.relative))
    ? `${base}.${native.ide}`
    : base;
}

/**
 * The targets a project's list shows, and how many it left out.
 *
 * Unavailable means this host cannot build it — `windows-xaml` on a Mac. Those rows sink to the
 * bottom rather than sorting away entirely, so the ones you can act on are the ones under the
 * cursor; hiding them is the separate `day.hideUnavailableTargets` choice.
 *
 * The partition is STABLE: within each half the project's own declaration order from `Day.toml`
 * survives, because that order is the author's and re-sorting it alphabetically would shuffle a
 * list someone deliberately arranged.
 *
 * A target the catalog does not know is treated as available. It may be a target this CLI is too
 * old to list, and burying — or hiding — a row on the strength of not recognizing it is how a
 * newer target silently disappears from the view.
 */
export function orderTargets(
  names: string[],
  hideUnavailable: boolean,
): { shown: string[]; hidden: number } {
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    const target = findTarget(name);
    (target && !isBuildableHere(target) ? unavailable : available).push(name);
  }
  return hideUnavailable
    ? { shown: available, hidden: unavailable.length }
    : { shown: [...available, ...unavailable], hidden: 0 };
}

/**
 * What a device row reads, looks like, and offers.
 *
 * Free and pure so the states can be checked without a tree, and because there are now three
 * sources feeding one row: whether the APP is running on it, what this session is doing TO it
 * (booting, stopping, or a boot that failed), and what the last listing said about the machine.
 * The first two win over the third — a listing taken while a simulator boots reports it as still
 * shut down, which is exactly the reading that made "add a device" look like it had done nothing.
 */
export function deviceRowState(input: {
  /** The app is live on this device. */
  running: boolean;
  /** What this session is doing to the device itself. */
  pending: Pending | undefined;
  /** A listing for this target is being fetched right now. */
  loading: boolean;
  listing: TargetDevices | undefined;
  device: { id: string; avd?: string } | undefined;
}): { bits: string[]; icon: string; color?: string; tag?: string } {
  const { running, pending: doing, listing, device } = input;
  const bits: string[] = [];
  if (running) {
    bits.push("running");
  }
  // An in-flight action outranks the listing, which cannot see it: a device asked to boot is not
  // in `devices` yet and is still in `bootable`, so the listing's word for it is "not running".
  if (doing === "booting") {
    bits.push("Booting…");
    return { bits, icon: "loading~spin" };
  }
  if (doing === "stopping") {
    bits.push("Stopping…");
    return { bits, icon: "loading~spin" };
  }
  const virtual = device && virtualDevice(listing, device);
  // The same matching rule the menu uses, so a row cannot read `not found` and offer Stop.
  const live = !!device && !!liveDevice(listing, device);
  if (doing === "failed" && !live) {
    // Kept until the device is actually seen, because a dialog that has been dismissed is the only
    // other record that the boot was even attempted.
    bits.push("failed to start");
  } else if (input.loading) {
    bits.push("checking…");
  } else if (listing?.available) {
    // `virtual.id` and not `virtual`: an emulator row that cannot say which AVD it is has no id
    // to start, and the device its serial names really is not there. `not found` is the honest
    // word for that, and the row still offers to adopt an AVD.
    bits.push(live ? "connected" : virtual?.id ? "not running" : "not found");
  }
  if (doing === "failed" && !live) {
    return {
      bits,
      icon: "error",
      color: "list.errorForeground",
      // Still offered, so the answer to a failed boot is the same row's own Start rather than
      // removing it and starting over.
      tag: tagFor(virtual),
    };
  }
  return {
    bits,
    icon: running ? "circle-filled" : "device-mobile",
    color: running ? "charts.green" : undefined,
    tag: tagFor(virtual),
  };
}

/** The one context-value tag a row carries for the action it can offer, if any. */
function tagFor(virtual: ReturnType<typeof virtualDevice>): string | undefined {
  if (!virtual) {
    return undefined;
  }
  const noun = virtual.noun === "simulator" ? "Simulator" : "Emulator";
  // `adopt` is the third state, and it earns its own tag because its menu entry has to READ
  // differently: "Start Emulator…", with the ellipsis that says it will ask which one.
  const verb = virtual.running ? "stop" : virtual.id ? "start" : "adopt";
  return `${verb}${noun}`;
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

  /** A project's target rows, ordered and filtered by `day.hideUnavailableTargets`. */
  private targetRows(project: DayProject): { shown: string[]; hidden: number } {
    return orderTargets(this.targetNames(project), hideUnavailableTargets(project.root));
  }

  getChildren(element?: Node): Node[] {
    // Projects ARE the roots: a "Projects" wrapper stopped earning its level once each project
    // grew a subtree of its own, and dropping it keeps the deepest row four deep instead of five.
    if (!element) {
      // The CLI first: every row below it is something that CLI will be asked to do, and when it
      // is missing or behind, that is the fact that explains the rest of the view.
      return [
        { kind: "cli" } as Node,
        ...this.deps.projects().map((p) => ({ kind: "project", root: p.root }) as Node),
      ];
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
      // Only mobile targets carry devices. Desktop and web have nowhere else to run, so giving
      // them a twisty would promise a choice that does not exist.
      const kind = findTarget(element.name)?.kind;
      if (!isMobile(kind)) {
        return [];
      }
      const configured = this.deps.state.devicesFor(element.root, element.name);
      // Device rows are about to be drawn, so THIS target's listing is worth having: the rows read
      // `connected` / `not running` off it, and their Start/Stop menu is offered from it. Started
      // here rather than in `getTreeItem` because that is synchronous and cannot wait on adb.
      //
      // Gated on there being nothing fresh and nothing in flight, which is what keeps it from
      // looping: the query refreshes the tree when it lands, that redraw asks again, and an
      // ungated ask would start another query and another refresh forever. It is also what keeps
      // the promise in the module header — one target's tools, only when its rows ask, never on
      // activation and never `adb` for an iOS row.
      if (configured.length > 0 && !cached(element.name) && !loading(element.name)) {
        void this.deps.refreshDevices(element.root, element.name);
      }
      return configured.map(
        (d) => ({ kind: "device", root: element.root, target: element.name, id: d.id }) as Node,
      );
    }
    if (element.kind === "group" && element.id === "targets") {
      const project = this.deps.projects().find((p) => p.root === element.root);
      return project
        ? this.targetRows(project).shown.map(
            (name) => ({ kind: "target", root: project.root, name }) as Node,
          )
        : [];
    }
    return [];
  }

  /**
   * The row above this one. Required by `TreeView.reveal`, and only that: nothing else in the tree
   * walks upwards.
   *
   * Adding a device is what needs it. A target row that had no devices carried no twisty at all,
   * and gaining one does not open it — VS Code remembers what the user last left collapsed — so a
   * device added from the "+" landed under a closed row and looked like nothing had happened.
   */
  getParent(node: Node): Node | undefined {
    switch (node.kind) {
      case "cli":
      case "project":
        return undefined;
      case "group":
        return { kind: "project", root: node.root };
      case "config":
        return { kind: "group", root: node.root, id: "config", label: "Configuration" };
      case "target":
        return { kind: "group", root: node.root, id: "targets", label: "Targets" };
      case "device":
        return { kind: "target", root: node.root, name: node.target };
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "cli":
        return cliItem(this.deps.versions());
      case "project":
        return this.projectItem(node.root);
      case "group":
        return this.groupItem(node);
      case "config":
        return this.configItem(node.root, node.which);
      case "target":
        return this.targetItem(node.root, node.name);
      case "device":
        return this.deviceItem(node.root, node.target, node.id);
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
      const project = this.deps.projects().find((p) => p.root === node.root);
      const hidden = project ? this.targetRows(project).hidden : 0;
      const bits: string[] = [];
      if (ticked > 0) {
        bits.push(`${ticked} ticked`);
      }
      if (running > 0) {
        bits.push(`${running} running`);
      }
      if (hidden > 0) {
        bits.push(`${hidden} unavailable hidden`);
      }
      item.description = bits.join(" · ");
      if (hidden > 0) {
        item.tooltip = `${hidden} target(s) this host cannot build are hidden. Turn off day.hideUnavailableTargets to list them.`;
      }
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
   * One configured device under a mobile target.
   *
   * Rendered from what was STORED when the device was added, not from a live listing: the row has
   * to draw the same whether or not the phone is plugged in right now, and `getTreeItem` is
   * synchronous — blocking the sidebar on adb would make every expand feel broken. The cached
   * listing only decorates it, saying whether the device is connected at the moment.
   */
  private deviceItem(root: string, target: string, id: string): vscode.TreeItem {
    const device = this.deps.state.devicesFor(root, target).find((d) => d.id === id);
    const item = new vscode.TreeItem(
      device?.label ?? id,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `device:${root}:${target}:${id}`;
    const running = this.deps.runner.isDeviceRunning(root, target, id);
    const state = deviceRowState({
      running,
      pending: pending(root, target, id),
      loading: loading(target),
      // Read from the cache only. Deliberately no query is started here: `getTreeItem` is
      // synchronous, and a configured device that is simply unplugged is a normal state rather
      // than a reason to shell out to simctl/adb/hdc every time the tree redraws.
      listing: cached(target),
      device,
    });
    item.description = state.bits.join(" · ");
    item.iconPath = new vscode.ThemeIcon(
      state.icon,
      state.color ? new vscode.ThemeColor(state.color) : undefined,
    );
    // Tags accumulate the way a target row's `.studio`/`.mobile` do, and the base states keep
    // their meaning: `dayDevice` vs `dayDeviceRunning` is about the APP, the tag is about the
    // device it would run on.
    item.contextValue = running ? "dayDeviceRunning" : "dayDevice";
    if (state.tag) {
      item.contextValue += `.${state.tag}`;
    }
    // Its own checkbox: which devices a launch goes to. Unticked rows stay listed — a device you
    // are not launching onto right now is still one you configured.
    const ticked = this.deps.state
      .tickedDevicesFor(root, target)
      .some((d) => d.id === id);
    item.checkboxState = ticked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = device
      ? `${device.label}\n${device.flag} ${device.id}${device.avd ? `\nAVD ${device.avd}` : ""}`
      : `${id}\nconfigured for ${target}`;
    return item;
  }

  private targetItem(root: string, name: string): vscode.TreeItem {
    const target = findTarget(name);
    const running = this.deps.runner.isRunning(root, name);
    const buildable = target ? isBuildableHere(target) : true;
    const selected = this.deps.state.selectionFor(root).targets.includes(name);

    // A twisty only once there is something under it. A mobile target with nothing configured used
    // to expand to a single fixed "Device" row; now it has no children until one is added, and an
    // empty expander that opens onto nothing reads as a broken row.
    const mobile = isMobile(target?.kind);
    const devices = mobile ? this.deps.state.devicesFor(root, name) : [];
    const item = new vscode.TreeItem(
      name,
      devices.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
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
    // With devices configured, the count says how many will actually be launched onto. That
    // wording carries what the checkbox cannot: VS Code tree checkboxes are two-state (the API's
    // `TreeItemCheckboxState` is Checked/Unchecked and the workbench renders a plain toggle), so a
    // partially-ticked target has no third visual state to show. The row reads "1 of 2 devices".
    const tickedDevices = mobile ? this.deps.state.tickedDevicesFor(root, name) : [];
    if (devices.length > 0) {
      parts.push(
        tickedDevices.length === devices.length
          ? devices.length === 1
            ? "1 device"
            : `${devices.length} devices`
          : `${tickedDevices.length} of ${devices.length} devices`,
      );
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

    item.contextValue = targetContextValue(
      item.contextValue,
      root,
      name,
      process.platform,
    );
    // Tags accumulate, so a row can read `dayTarget.mobile.studio`. Every menu that matches a
    // target row allows any number of them (`(\.\w+)*`) rather than exactly one.
    if (mobile) {
      item.contextValue += ".mobile";
    }

    // Only buildable targets get a selection checkbox — a target this host cannot build has
    // nothing to tick. Deliberately NO `item.command`: the checkbox is the only thing that
    // toggles, so clicking the row selects it the way every other checkbox tree in VS Code
    // behaves. Binding the whole row to the toggle meant a row could not be selected, expanded,
    // or right-clicked without also flipping whether it builds.
    if (buildable) {
      // With devices configured the target's tick is the aggregate of theirs: checked while ANY is
      // ticked, because that is exactly when this target still launches. Reading it from the
      // target's own selection instead would leave the row ticked with every device unticked —
      // a row claiming it will run when nothing under it would.
      const on = devices.length > 0 ? tickedDevices.length > 0 : selected;
      item.checkboxState = on
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    item.tooltip = target
      ? `${name} — ${kindLabel(target)}${buildable ? "" : ` (requires a ${target.host} host)`}`
      : name;
    return item;
  }
}
