// Launches Day apps through the Tasks API and tracks the running executions so individual targets can
// be stopped and restarted. Each launch is its own Task (one integrated terminal per target), so
// output is filtered per-target automatically; multi-target = one task per selected target.
//
// Everything is keyed by PROJECT AND TARGET. A window can hold dozens of Day apps, and most of them
// build `macos-appkit`: keyed by target alone, launching one app's macos-appkit read as "that is
// already running", stopped the other app's, and left one Stop button for two processes.

import * as childProcess from "child_process";
import * as vscode from "vscode";

import { DeviceChoice, State } from "./config";
import { renderCommand, resolveCli, stopArgs } from "./cli";
import { buildDayTask, DayTaskDefinition } from "./tasks";

/** One launch, identified the way the rest of the extension addresses it. */
export interface RunRef {
  /** Project root (the directory holding Day.toml). */
  root: string;
  target: string;
  /** Which configured device this run is on; absent means the CLI's "every connected one". */
  device?: string;
}

/** NUL joins the parts: it cannot occur in a path, a target name or a device id, so the key is
 *  unambiguous where `${root}:${target}` would collide on a project whose path ends in a target's
 *  name. The device is part of it because one target can be live on several devices at once —
 *  keyed by target alone, the second launch would evict the first from the map and its Stop would
 *  then terminate nothing. An empty last part is "no device chosen", the CLI's own default. */
function key(root: string, target: string, device?: string): string {
  return `${root}\u0000${target}\u0000${device ?? ""}`;
}

interface Running {
  ref: RunRef;
  execution: vscode.TaskExecution;
  pid?: number;
}

export class Runner implements vscode.Disposable {
  private running = new Map<string, Running>();
  // Launches from the native Run and Debug UI (F5 / Run menu). Tracked alongside task-launched
  // ones so the cockpit's "running" view, Stop, and restart cover both paths.
  private debug = new Map<string, vscode.DebugSession>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private subs: vscode.Disposable[] = [];

  constructor(
    private readonly state: State,
    /** Where a failed `day stop` is reported; silent is wrong, a modal is too loud. */
    private readonly output?: vscode.OutputChannel,
  ) {
    this.subs.push(
      vscode.tasks.onDidStartTaskProcess((e) => {
        const ref = this.taskRef(e.execution.task.definition as DayTaskDefinition);
        const r = ref && this.running.get(key(ref.root, ref.target, ref.device));
        if (r) {
          r.pid = e.processId;
          this.emitter.fire();
        }
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        const ref = this.taskRef(e.execution.task.definition as DayTaskDefinition);
        if (ref && this.running.delete(key(ref.root, ref.target, ref.device))) {
          this.emitter.fire();
        }
      }),
      vscode.debug.onDidStartDebugSession((s) => {
        const ref = this.debugRef(s);
        if (ref) {
          this.debug.set(key(ref.root, ref.target), s);
          this.emitter.fire();
        }
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        const ref = this.debugRef(s);
        if (ref && this.debug.delete(key(ref.root, ref.target))) {
          this.emitter.fire();
        }
      }),
    );
  }

  /** The project+target a `day` launch task addresses, if it is one of ours. */
  private taskRef(def: DayTaskDefinition): RunRef | undefined {
    if (def?.type !== "day" || def.command !== "launch" || typeof def.target !== "string") {
      return undefined;
    }
    // A task authored in tasks.json may omit `project`; it then means the focused one, which is
    // what buildDayTask resolved when it ran.
    const root = def.project || this.state.focusedRoot;
    return root ? { root, target: def.target, device: def.device?.id } : undefined;
  }

  /** The project+target a debug session launches, if it is one of ours. */
  private debugRef(s: vscode.DebugSession): RunRef | undefined {
    if (s.type !== "day") {
      return undefined;
    }
    const cfg = s.configuration as { target?: unknown; project?: unknown };
    const target = typeof cfg.target === "string" ? cfg.target : "";
    if (!target) {
      return undefined;
    }
    const root = typeof cfg.project === "string" && cfg.project ? cfg.project : this.state.focusedRoot;
    return root ? { root, target } : undefined;
  }

  /** Whether a target is live on ANY device — what the target row and its Stop button ask. */
  isRunning(root: string, target: string): boolean {
    return this.runningRefs().some((r) => r.root === root && r.target === target);
  }

  /** Whether one configured device is live — what a device row's Play/Stop asks. */
  isDeviceRunning(root: string, target: string, device: string): boolean {
    const k = key(root, target, device);
    return this.running.has(k) || this.debug.has(k);
  }

  /** Every live launch, across every project. */
  runningRefs(): RunRef[] {
    const out = new Map<string, RunRef>();
    for (const [k, r] of this.running) {
      out.set(k, r.ref);
    }
    for (const [k, s] of this.debug) {
      const ref = this.debugRef(s);
      if (ref) {
        out.set(k, ref);
      }
    }
    return [...out.values()];
  }

  /** The targets running in one project, each named once however many devices it is live on. */
  runningIn(root: string): string[] {
    return [
      ...new Set(
        this.runningRefs()
          .filter((r) => r.root === root)
          .map((r) => r.target),
      ),
    ];
  }

  private definition(
    command: "build" | "launch",
    root: string,
    target: string,
    device?: DeviceChoice,
  ): DayTaskDefinition {
    const sel = this.state.selectionFor(root);
    return {
      type: "day",
      command,
      target,
      profile: sel.profile,
      locale: sel.locale || undefined,
      script: sel.script || undefined,
      project: root,
      // Projected field by field rather than passed whole. The definition IS the task's identity,
      // so anything riding along in it renames the task: `avd` is a note about which emulator a
      // serial belongs to, and a stored device that gained one would look like a different task
      // from the run already going.
      device: device && { id: device.id, label: device.label, flag: device.flag },
    };
  }

  /**
   * The runs one target's Play button starts: one per configured device, or a single run on the
   * CLI's own "every connected device" when none is configured.
   *
   * `[undefined]` rather than `[]` for the unconfigured case on purpose — an empty list would make
   * Play silently do nothing for every desktop target, which have no devices by definition.
   */
  private runsFor(root: string, target: string): (DeviceChoice | undefined)[] {
    // Ticked devices only. A target with devices configured but none ticked launches nowhere:
    // running onto "every connected device" there would ignore the very checkboxes that were just
    // cleared, which is the opposite of what unticking them meant.
    if (this.state.devicesFor(root, target).length > 0) {
      return this.state.tickedDevicesFor(root, target);
    }
    return [undefined];
  }

  async runTargets(root: string, targets: string[]): Promise<void> {
    if (!root) {
      throw new Error("No Day project selected.");
    }
    if (targets.length === 0) {
      throw new Error("No targets selected. Tick one or more targets in the Day view.");
    }
    for (const target of targets) {
      // Re-running a live target restarts it rather than stacking a second instance — whether it
      // was launched from the cockpit (a task) or the native Run UI (a debug session). Stopping by
      // TARGET covers every device it was running on, including ones since removed from the list.
      if (this.isRunning(root, target)) {
        await this.stop(root, target);
      }
      const runs = this.runsFor(root, target);
      if (runs.length === 0) {
        vscode.window.showInformationMessage(
          `Day: ${target} has devices configured but none ticked — tick one to launch on it.`,
        );
        continue;
      }
      for (const device of runs) {
        await this.launchOne(root, target, device);
      }
    }
    this.emitter.fire();
  }

  async buildTargets(root: string, targets: string[]): Promise<void> {
    if (!root) {
      throw new Error("No Day project selected.");
    }
    if (targets.length === 0) {
      throw new Error("No targets selected. Tick one or more targets in the Day view.");
    }
    for (const target of targets) {
      await vscode.tasks.executeTask(buildDayTask(this.definition("build", root, target)));
    }
  }

  /** Launch one target onto one device (or onto the CLI's default when `device` is absent). */
  private async launchOne(
    root: string,
    target: string,
    device: DeviceChoice | undefined,
  ): Promise<void> {
    const exec = await vscode.tasks.executeTask(
      buildDayTask(this.definition("launch", root, target, device)),
    );
    this.running.set(key(root, target, device?.id), {
      ref: { root, target, device: device?.id },
      execution: exec,
    });
  }

  /** Run one target on ONE of its configured devices — a device row's own Play button. */
  async runDevice(root: string, target: string, device: DeviceChoice): Promise<void> {
    if (this.isDeviceRunning(root, target, device.id)) {
      await this.stopDevice(root, target, device.id);
    }
    await this.launchOne(root, target, device);
    this.emitter.fire();
  }

  /** Terminate one tracked task run and forget it. Silent when there is nothing under that key. */
  private forget(k: string): void {
    const r = this.running.get(k);
    if (r) {
      r.execution.terminate();
      this.running.delete(k);
      this.emitter.fire();
    }
  }

  /** End any debug session for this target, whichever device it was launched against. */
  private async stopDebugFor(root: string, target: string): Promise<void> {
    for (const [k, session] of [...this.debug]) {
      const ref = this.debugRef(session);
      if (ref && ref.root === root && ref.target === target) {
        await vscode.debug.stopDebugging(session);
        this.debug.delete(k);
        this.emitter.fire();
      }
    }
  }

  /**
   * Stop one device's run of a target.
   *
   * No `day stop` here, unlike [`stop`]: the CLI stops a target's session for the PROJECT, not for
   * one device, so calling it would take down the target's other devices as well — the opposite of
   * what a single row's Stop means.
   */
  async stopDevice(root: string, target: string, device: string): Promise<void> {
    this.forget(key(root, target, device));
  }

  /** Stop every run of a target, whatever devices it landed on. */
  async stop(root: string, target: string): Promise<void> {
    for (const ref of this.runningRefs()) {
      if (ref.root === root && ref.target === target) {
        this.forget(key(root, target, ref.device));
      }
    }
    await this.stopDebugFor(root, target);
    // Then ask the CLI to stop the APP. Ending the task only kills what `day` launched as its own
    // child, which is the whole story on a desktop and none of it on a device: an Android app is
    // started with `am start` and outlives its launcher, so Stop left it on screen. `day stop`
    // also drops the session, without which `day running` keeps reporting a launch that is gone.
    await this.stopViaCli(root, target);
  }

  /** `day stop -p <target>`, best effort: Stop has already done what it can locally, so a CLI
   *  that cannot be resolved must not turn a stopped app into an error dialog. */
  private async stopViaCli(root: string, target: string): Promise<void> {
    const cli = resolveCli(root);
    const args = [...cli.baseArgs, ...stopArgs(root, target)];
    await new Promise<void>((resolve) => {
      childProcess.execFile(
        cli.command,
        args,
        { cwd: cli.cwd ?? root, timeout: 60_000 },
        (err, _stdout, stderr) => {
          if (err) {
            this.output?.appendLine(
              `✗ ${renderCommand(cli, args.slice(cli.baseArgs.length))}: ${stderr.trim() || err.message}`,
            );
          }
          resolve();
        },
      );
    });
  }

  async stopAll(): Promise<void> {
    for (const ref of this.runningRefs()) {
      await this.stop(ref.root, ref.target);
    }
  }

  async restart(root: string, target: string): Promise<void> {
    await this.stop(root, target);
    await this.runTargets(root, [target]);
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
