// QuickPick / input flows for the editable configuration: build mode, log level, locale, dayscript,
// and project.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { DeviceChoice, Profile } from "./config";
import { TargetDevices } from "./devices";
import { DayProject } from "./project";
import { LogLevel } from "./tasks";
import { catalog, findTarget, isBuildableHere } from "./targets";

export async function pickMode(current: Profile): Promise<Profile | undefined> {
  const items: (vscode.QuickPickItem & { value: Profile })[] = [
    { label: "debug", description: "fast builds, unoptimized", value: "debug", picked: current === "debug" },
    { label: "release", description: "optimized", value: "release", picked: current === "release" },
  ];
  const chosen = await vscode.window.showQuickPick(items, { title: "Day: Build Mode", placeHolder: current });
  return chosen?.value;
}

/** What the device picker came back with. `all` clears any pin; `boot` asks to start one first. */
export type DevicePick =
  | { kind: "device"; device: DeviceChoice }
  | { kind: "boot"; id: string; name: string };

/**
 * Choose a device to ADD to a target's configured list.
 *
 * `undefined` means cancelled. There is no "all connected" entry any more: launching on every
 * connected device is what a target with an EMPTY list does, so offering it here as a pick would
 * be offering to configure the absence of configuration.
 *
 * Connected devices come first because they are the ones that can be launched onto right now;
 * the rest are offered under a separator as something to boot, which is the common iOS case since
 * `simctl install` cannot reach a shut-down simulator. Devices already configured stay on the list
 * but are marked and cannot be picked twice.
 */
export async function pickDevice(
  target: string,
  listing: Promise<TargetDevices | undefined>,
  configured: DeviceChoice[],
): Promise<DevicePick | undefined> {
  type Item = vscode.QuickPickItem & { pick?: DevicePick };

  // Built by hand rather than through `showQuickPick`, which cannot be shown before its items are
  // known: enumerating devices shells out to simctl, adb and hdc, and the wait for those was
  // happening with nothing on screen at all. This opens immediately, spins while the CLI answers,
  // and fills in — Escape cancels it at any point, including mid-query.
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Day: add a device for ${target}`;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.placeholder = "Looking for connected devices…";
  qp.show();

  // Closed covers BOTH ways out — Escape and accept — because everything below mutates the
  // QuickPick, and doing that after it is disposed throws. The wait is exactly the window in
  // which a user can walk away from it, so this is the common path, not the edge case.
  let closed = false;
  const result = new Promise<DevicePick | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.pick);
      qp.hide();
    });
    qp.onDidHide(() => {
      closed = true;
      resolve(undefined);
      qp.dispose();
    });
  });

  const found = await listing;
  if (closed) {
    return result; // dismissed, or accepted "All connected", before the listing landed
  }
  qp.busy = false;

  if (found && !found.available) {
    // A missing toolchain is an answer, not an empty list — say it where the user is looking
    // rather than in a notification behind the picker.
    qp.placeholder = found.note ?? "this target's toolchain was not found";
    return result;
  }


  const connected = found?.devices ?? [];
  const already = new Set(configured.map((d) => d.id));
  const items: Item[] = [];
  for (const d of connected) {
    const here = already.has(d.id);
    items.push({
      label: here ? `$(check) ${d.name}` : d.name,
      description: [here ? "already added" : undefined, d.state, d.runtime, d.arch]
        .filter(Boolean)
        .join(" · "),
      detail: d.id,
      // No `pick` on one already configured, so choosing it closes the picker and changes nothing
      // rather than appearing to add a second copy.
      pick:
        d.flag && !here
          ? { kind: "device", device: { id: d.id, label: d.name, flag: d.flag, avd: d.avd } }
          : undefined,
    });
  }
  if (items.length === 0) {
    qp.placeholder = "Nothing connected for this target";
  }
  const bootable = found?.bootable ?? [];
  if (bootable.length > 0) {
    items.push({ label: "Not running", kind: vscode.QuickPickItemKind.Separator });
    for (const d of bootable) {
      items.push({
        label: `$(play) ${d.name}`,
        description: d.runtime,
        detail: "Start it, then launch on it",
        pick: { kind: "boot", id: d.id, name: d.name },
      });
    }
  }
  qp.items = items;
  // Land on the first device that can actually be added, so Enter does the obvious thing rather
  // than re-selecting one that is already on the list.
  const active = items.find((i) => i.pick);
  if (active) {
    qp.activeItems = [active];
  }
  return result;
}

export async function pickLogLevel(current: LogLevel): Promise<LogLevel | undefined> {
  const items: (vscode.QuickPickItem & { value: LogLevel })[] = [
    { label: "trace", description: "everything, including per-statement SQL", value: "trace" },
    { label: "debug", description: "framework diagnostics (Day's debug-build default)", value: "debug" },
    { label: "info", description: "notable events (Day's release default)", value: "info" },
    { label: "warn", description: "problems only", value: "warn" },
    { label: "error", description: "failures only", value: "error" },
    { label: "off", description: "nothing", value: "off" },
  ];
  for (const item of items) {
    item.picked = item.value === current;
  }
  const chosen = await vscode.window.showQuickPick(items, { title: "Day: Log Level", placeHolder: current });
  return chosen?.value;
}

/** Returns "" for the default locale, a BCP-47 string, or undefined if cancelled. */
export async function pickLocale(project: DayProject | undefined, current: string): Promise<string | undefined> {
  const known = new Set<string>(["en", "fr", "en-XA", "fr-XA"]);
  // Add any locales the project ships (folders under <root>/resource/locales).
  if (project) {
    const dir = path.join(project.root, "resource", "locales");
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          known.add(e.name);
        }
      }
    } catch {
      /* no resource/locales dir */
    }
  }
  const CUSTOM = "$(edit) Custom…";
  const items: vscode.QuickPickItem[] = [
    { label: "(default)", description: "the app/system default" },
    ...[...known].sort().map((l) => ({ label: l } as vscode.QuickPickItem)),
    { label: CUSTOM },
  ];
  const chosen = await vscode.window.showQuickPick(items, {
    title: "Day: Locale",
    placeHolder: current.length > 0 ? current : "(default)",
  });
  if (!chosen) {
    return undefined;
  }
  if (chosen.label === "(default)") {
    return "";
  }
  if (chosen.label === CUSTOM) {
    const typed = await vscode.window.showInputBox({
      title: "Day: Locale",
      prompt: "BCP-47 locale tag (e.g. de, ja, en-XA)",
      value: current,
    });
    return typed === undefined ? undefined : typed.trim();
  }
  return chosen.label;
}

/** Returns "" for no script, an absolute script path, or undefined if cancelled. */
export async function pickScript(project: DayProject | undefined, current: string): Promise<string | undefined> {
  const scripts: string[] = [];
  if (project) {
    const dir = path.join(project.root, "dayscript");
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && /\.(ya?ml|day)$/.test(e.name)) {
          scripts.push(path.join(dir, e.name));
        }
      }
    } catch {
      /* no scripts dir */
    }
  }
  const BROWSE = "$(folder-opened) Browse…";
  const items: vscode.QuickPickItem[] = [
    { label: "(none)", description: "run without a dayscript" },
    ...scripts.map((s) => ({ label: path.basename(s), description: s } as vscode.QuickPickItem)),
    { label: BROWSE },
  ];
  const chosen = await vscode.window.showQuickPick(items, {
    title: "Day: Dayscript",
    placeHolder: current.length > 0 ? path.basename(current) : "(none)",
  });
  if (!chosen) {
    return undefined;
  }
  if (chosen.label === "(none)") {
    return "";
  }
  if (chosen.label === BROWSE) {
    const uris = await vscode.window.showOpenDialog({
      title: "Select a dayscript",
      canSelectMany: false,
      filters: { Dayscript: ["yaml", "yml", "day"] },
      defaultUri: project ? vscode.Uri.file(project.root) : undefined,
    });
    return uris && uris.length > 0 ? uris[0].fsPath : undefined;
  }
  return chosen.description ?? chosen.label;
}

export async function pickProject(projects: DayProject[], current?: string): Promise<DayProject | undefined> {
  if (projects.length === 0) {
    return undefined;
  }
  const items = projects.map((p) => ({
    label: p.name,
    description: p.id,
    detail: p.root,
    picked: p.root === current,
    project: p,
  }));
  const chosen = await vscode.window.showQuickPick(items, { title: "Day: Select Project" });
  return chosen?.project;
}

/**
 * Multi-select the run/build targets. Buildable targets of the project lead the list (declared
 * order), the rest of the host-buildable catalog follows under a separator, and targets this
 * host cannot build appear last, disabled-looking and stripped from the result.
 * Returns the chosen names, or undefined if cancelled.
 */
export async function pickTargets(
  project: DayProject | undefined,
  current: string[],
): Promise<string[] | undefined> {
  type Item = vscode.QuickPickItem & { name?: string };
  const declared = project?.targets ?? [];
  const items: Item[] = [];

  const push = (name: string): void => {
    const t = findTarget(name);
    const buildable = t ? isBuildableHere(t) : true;
    items.push({
      name: buildable ? name : undefined,
      label: buildable ? `$(vm) ${name}` : `$(circle-slash) ${name}`,
      description: buildable ? t?.label : "not buildable on this host",
      picked: buildable && current.includes(name),
    });
  };

  for (const name of declared) {
    push(name);
  }
  const extras = catalog()
    .map((t) => t.name)
    .filter((n) => !declared.includes(n) && isBuildableHere(findTarget(n)!));
  if (extras.length > 0) {
    items.push({ label: "also buildable here", kind: vscode.QuickPickItemKind.Separator });
    for (const name of extras) {
      push(name);
    }
  }

  const chosen = await vscode.window.showQuickPick(items, {
    title: "Day: Targets",
    placeHolder: "Select the targets Run and Build act on",
    canPickMany: true,
  });
  if (!chosen) {
    return undefined;
  }
  return chosen.map((i) => i.name).filter((n): n is string => typeof n === "string");
}
