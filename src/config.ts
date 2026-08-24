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
   * Chosen device per target name. A target with no entry launches onto every connected device,
   * which is the CLI's own default — so an untouched project behaves exactly as it did before.
   */
  devices?: Record<string, DeviceChoice>;
}

/** One project's stored slice. Every field optional: absent means "fall back to the setting". */
type StoredSelection = Partial<Selection>;

interface Stored {
  /** Root of the focused project. */
  focused?: string;
  /** Selections by project root. */
  byProject?: Record<string, StoredSelection>;
}

const KEY = "day.projectSelections";

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
      devices: slice.devices ?? {},
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

  /** Choose the device one target launches onto, or clear it back to "every connected device". */
  chooseDevice(root: string, target: string, device: DeviceChoice | undefined): Promise<void> {
    const devices = { ...this.selectionFor(root).devices };
    if (device) {
      devices[target] = device;
    } else {
      delete devices[target];
    }
    return this.updateFor(root, { devices });
  }

  /** Tick or untick one target of one project. Named explicitly rather than defaulting to the
   *  focused one: every checkbox in the tree belongs to a project the row already identifies. */
  toggleTargetFor(root: string, name: string): Promise<void> {
    const cur = this.selectionFor(root).targets;
    const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
    return this.updateFor(root, { targets: next });
  }
}
