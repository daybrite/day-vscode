// The build/run selection — which targets, mode, locale and dayscript — held PER PROJECT, plus
// which project is focused, persisted per-workspace in the extension's Memento. A change event lets
// the tree and status bar refresh when any of it is edited.
//
// Per project, not per window: a window can hold dozens of Day apps (scripts/dev.sh takes a list),
// and one shared selection meant ticking `ios-uikit` in one app silently ticked it in the next. The
// focused project is what the Configuration rows and the plain Run button act on; every project's
// selection stays put whether or not it is focused, which is what lets `Day: Run All Projects`
// launch across all of them.

import * as vscode from "vscode";

export type Profile = "debug" | "release";

/**
 * The device a target launches onto, as `day devices list --json` described it.
 *
 * `flag` rides along rather than being derived from the target: iOS alone needs
 * `--ios-simulator` for a booted simulator and `--ios-device` for a plugged-in phone, and letting
 * the CLI name the flag per device means a new device class needs no extension release.
 */
export interface DeviceChoice {
  id: string;
  label: string;
  flag: string;
}

export interface Selection {
  targets: string[];
  profile: Profile;
  /** BCP-47 locale; "" = the app/system default. */
  locale: string;
  /** Dayscript path; "" = none. */
  script: string;
  /**
   * The devices configured for each target, in the order they were added.
   *
   * A target with no entry launches onto every connected device, which is the CLI's own default —
   * so a project nobody has configured behaves exactly as it did before. One with several launches
   * onto each of them, one task apiece.
   */
  deviceList?: Record<string, DeviceChoice[]>;
}

/** One project's stored slice. Every field optional: absent means "fall back to the setting". */
type StoredSelection = Partial<Selection> & {
  /**
   * Superseded by `deviceList`. It held ONE pinned device per target; a workspace written before
   * multi-device support still carries it, and [`State.selectionFor`] promotes it to a
   * single-entry list so nobody's pinned simulator silently reverts to "all connected".
   */
  devices?: Record<string, DeviceChoice>;
};

interface Stored {
  /** Root of the focused project. */
  focused?: string;
  /** Selections by project root. */
  byProject?: Record<string, StoredSelection>;
}

const KEY = "day.projectSelections";

/** The pre-multi-device shape: one pinned device per target becomes a one-entry list. */
function promoteLegacyDevices(
  legacy: Record<string, DeviceChoice> | undefined,
): Record<string, DeviceChoice[]> {
  const out: Record<string, DeviceChoice[]> = {};
  for (const [target, device] of Object.entries(legacy ?? {})) {
    out[target] = [device];
  }
  return out;
}

export class State {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly mem: vscode.Memento) {}

  private stored(): Stored {
    return this.mem.get<Stored>(KEY) ?? {};
  }

  private async write(next: Stored): Promise<void> {
    await this.mem.update(KEY, next);
    this.emitter.fire();
  }

  /** Root of the focused project, or `undefined` before one is chosen. */
  get focusedRoot(): string | undefined {
    return this.stored().focused;
  }

  /** The focused project's selection. */
  get selection(): Selection {
    return this.selectionFor(this.focusedRoot);
  }

  /** One project's selection, with the settings' defaults filled in for anything unset. */
  selectionFor(root: string | undefined): Selection {
    const slice = (root && this.stored().byProject?.[root]) || {};
    const cfg = vscode.workspace.getConfiguration("day");
    return {
      targets: slice.targets ?? [],
      profile: slice.profile ?? (cfg.get<Profile>("defaultProfile") ?? "debug"),
      locale: slice.locale ?? (cfg.get<string>("defaultLocale") ?? ""),
      script: slice.script ?? "",
      deviceList: slice.deviceList ?? promoteLegacyDevices(slice.devices),
    };
  }

  /** Point the cockpit at a project: the Configuration rows, the plain Run button and the status
   *  bar all follow it. Its stored selection is untouched — focusing is not editing. */
  async focus(root: string): Promise<void> {
    const prev = this.stored();
    if (prev.focused === root) {
      return;
    }
    await this.write({ focused: root, byProject: prev.byProject });
  }

  /** Apply `patch` to the FOCUSED project. A no-op when no project is open. */
  async update(patch: Partial<Selection>): Promise<void> {
    const root = this.focusedRoot;
    if (!root) {
      return;
    }
    await this.updateFor(root, patch);
  }

  /** Apply `patch` to one project WITHOUT focusing it — the fan-out edits in the projects tree. */
  async updateFor(root: string, patch: Partial<Selection>): Promise<void> {
    const prev = this.stored();
    await this.write({
      focused: prev.focused,
      byProject: {
        ...(prev.byProject ?? {}),
        [root]: { ...(prev.byProject?.[root] ?? {}), ...patch },
      },
    });
  }

  /** The devices configured for one target, in the order they were added. */
  devicesFor(root: string, target: string): DeviceChoice[] {
    return this.selectionFor(root).deviceList?.[target] ?? [];
  }

  /**
   * Add a device to a target, keeping the order they were added in.
   *
   * Adding one already there is a no-op rather than a second row: the picker lists what is
   * connected, so re-picking a device already configured is an easy thing to do by accident, and
   * two identical rows would each launch and then fight over the same device.
   */
  addDevice(root: string, target: string, device: DeviceChoice): Promise<void> {
    const current = this.devicesFor(root, target);
    if (current.some((d) => d.id === device.id)) {
      return Promise.resolve();
    }
    return this.writeDevices(root, target, [...current, device]);
  }

  /** Remove one configured device. The target falls back to "all connected" once none are left. */
  removeDevice(root: string, target: string, id: string): Promise<void> {
    return this.writeDevices(
      root,
      target,
      this.devicesFor(root, target).filter((d) => d.id !== id),
    );
  }

  private writeDevices(root: string, target: string, list: DeviceChoice[]): Promise<void> {
    const deviceList = { ...this.selectionFor(root).deviceList };
    if (list.length > 0) {
      deviceList[target] = list;
    } else {
      // Dropped rather than left as an empty array, so "configured nothing" and "configured
      // nothing after removing the last one" are the same stored state.
      delete deviceList[target];
    }
    return this.updateFor(root, { deviceList });
  }

  /** Tick or untick one target of one project. Named explicitly rather than defaulting to the
   *  focused one: every checkbox in the tree belongs to a project the row already identifies. */
  toggleTargetFor(root: string, name: string): Promise<void> {
    const cur = this.selectionFor(root).targets;
    const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
    return this.updateFor(root, { targets: next });
  }
}
