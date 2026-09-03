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
  /**
   * The AVD an Android emulator is running, when the CLI could name one.
   *
   * `id` is an adb serial there, and a serial is a CONSOLE PORT rather than an identity: stop the
   * emulator and it names nothing, start it again beside another one and it comes back as a
   * different serial. The AVD is what survives that, so it is what lets a stopped row still say
   * which emulator it is and offer to start it. Absent everywhere else — a simulator's UDID and a
   * phone's serial are already stable.
   */
  avd?: string;
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
  /**
   * Which of a target's configured devices are ticked, by device id.
   *
   * Separate from `deviceList` rather than a flag on each entry: a `DeviceChoice` is handed
   * straight to the task definition, and VS Code keys a task on that definition's declared
   * properties — a `checked` field riding along would put the tick into the task's IDENTITY, so
   * unticking a running device would look like a different task.
   *
   * A target with configured devices and NO entry here has them all ticked: adding a device is
   * saying you want to run on it, so it arrives ticked and this map only records departures from
   * that.
   */
  deviceTicks?: Record<string, string[]>;
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
      deviceTicks: slice.deviceTicks ?? {},
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
    // Arrives TICKED. `tickedDevicesFor` reads an absent entry as "all of them", which covers the
    // first device; once anything has been unticked the entry exists, and a new device would
    // otherwise land unticked — added on purpose, yet silently not launched onto.
    const ticks = this.selectionFor(root).deviceTicks?.[target];
    if (ticks) {
      return this.writeDevicesAndTicks(root, target, [...current, device], [
        ...ticks,
        device.id,
      ]);
    }
    return this.writeDevices(root, target, [...current, device]);
  }

  /**
   * Swap one configured device for the same device under a new id, keeping its place and its tick.
   *
   * What restarting an Android emulator needs: the row is the same emulator, but its adb serial is
   * a console port the next boot may not get back, and `--android-device` selects by that serial.
   * Removing and re-adding would send the row to the bottom of the list and re-tick it, so the
   * entry is rewritten in place instead.
   */
  replaceDevice(
    root: string,
    target: string,
    id: string,
    next: DeviceChoice,
  ): Promise<void> {
    const current = this.devicesFor(root, target);
    if (!current.some((d) => d.id === id) || current.some((d) => d.id === next.id)) {
      // Nothing to rename, or the new id is already its own row — writing either would leave two
      // rows for one device, each launching onto it.
      return Promise.resolve();
    }
    const ticks = this.selectionFor(root).deviceTicks?.[target];
    return this.writeDevicesAndTicks(
      root,
      target,
      current.map((d) => (d.id === id ? next : d)),
      ticks?.map((t) => (t === id ? next.id : t)),
    );
  }

  /** Remove one configured device. The target falls back to "all connected" once none are left. */
  removeDevice(root: string, target: string, id: string): Promise<void> {
    return this.writeDevices(
      root,
      target,
      this.devicesFor(root, target).filter((d) => d.id !== id),
    );
  }

  /**
   * The configured devices of a target that are ticked, in configured order.
   *
   * Absent state means all of them, so a project that predates ticking — or one where nobody has
   * unticked anything — launches on everything it lists, which is what it did before.
   */
  tickedDevicesFor(root: string, target: string): DeviceChoice[] {
    const all = this.devicesFor(root, target);
    const ticks = this.selectionFor(root).deviceTicks?.[target];
    return ticks === undefined ? all : all.filter((d) => ticks.includes(d.id));
  }

  /** Tick or untick one device. */
  setDeviceTicked(
    root: string,
    target: string,
    id: string,
    ticked: boolean,
  ): Promise<void> {
    const current = new Set(this.tickedDevicesFor(root, target).map((d) => d.id));
    if (ticked) {
      current.add(id);
    } else {
      current.delete(id);
    }
    return this.writeTicks(root, target, current);
  }

  /** Tick or untick every configured device of a target — what the target's own checkbox does. */
  setAllDevicesTicked(root: string, target: string, ticked: boolean): Promise<void> {
    const all = this.devicesFor(root, target).map((d) => d.id);
    return this.writeTicks(root, target, new Set(ticked ? all : []));
  }

  private writeTicks(root: string, target: string, ids: Set<string>): Promise<void> {
    const deviceTicks = { ...this.selectionFor(root).deviceTicks };
    // Normalised to configured order. Reads filter the configured list, so order here is not
    // observable either way — this only keeps the persisted value from churning as ticks are
    // toggled back and forth.
    deviceTicks[target] = this.devicesFor(root, target)
      .map((d) => d.id)
      .filter((id) => ids.has(id));
    return this.updateFor(root, { deviceTicks });
  }

  private writeDevices(root: string, target: string, list: DeviceChoice[]): Promise<void> {
    return this.writeDevicesAndTicks(root, target, list, undefined);
  }

  /** One write for both maps: two `updateFor` calls would each build from a pre-write snapshot. */
  private writeDevicesAndTicks(
    root: string,
    target: string,
    list: DeviceChoice[],
    ticks: string[] | undefined,
  ): Promise<void> {
    const selection = this.selectionFor(root);
    const deviceList = { ...selection.deviceList };
    if (list.length > 0) {
      deviceList[target] = list;
    } else {
      // Dropped rather than left as an empty array, so "configured nothing" and "configured
      // nothing after removing the last one" are the same stored state.
      delete deviceList[target];
    }

    // The ticks follow the list: a device removed and later re-added must arrive ticked like any
    // other new one, rather than carrying a stale untick nobody can see. Written in the SAME
    // update as the list — two `updateFor` calls both read the stored object first, so the second
    // would be built from a snapshot taken before the first landed and would drop its change.
    const deviceTicks = { ...selection.deviceTicks };
    if (ticks) {
      deviceTicks[target] = ticks;
    }
    const stored = deviceTicks[target];
    if (stored) {
      const ids = new Set(list.map((d) => d.id));
      const kept = stored.filter((id) => ids.has(id));
      if (list.length > 0) {
        deviceTicks[target] = kept;
      } else {
        delete deviceTicks[target];
      }
    }
    return this.updateFor(root, { deviceList, deviceTicks });
  }

  /** Tick or untick one target of one project. Named explicitly rather than defaulting to the
   *  focused one: every checkbox in the tree belongs to a project the row already identifies. */
  toggleTargetFor(root: string, name: string): Promise<void> {
    const cur = this.selectionFor(root).targets;
    const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
    return this.updateFor(root, { targets: next });
  }
}
