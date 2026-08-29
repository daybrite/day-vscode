// Launches Day apps through the Tasks API and tracks the running executions so individual targets can
// be stopped and restarted. Each launch is its own Task (one integrated terminal per target), so
// output is filtered per-target automatically; multi-target = one task per selected target.
//
// Everything is keyed by PROJECT AND TARGET. A window can hold dozens of Day apps, and most of them
// build `macos-appkit`: keyed by target alone, launching one app's macos-appkit read as "that is
// already running", stopped the other app's, and left one Stop button for two processes.

import * as childProcess from "child_process";
import * as vscode from "vscode";

import { State } from "./config";
import { renderCommand, resolveCli, stopArgs } from "./cli";
import { buildDayTask, DayTaskDefinition } from "./tasks";

/** One launch, identified the way the rest of the extension addresses it. */
export interface RunRef {
  /** Project root (the directory holding Day.toml). */
  root: string;
  target: string;
}

/** NUL joins the two halves: it cannot occur in a path or a target name, so the key is unambiguous
 *  where `${root}:${target}` would collide on a project whose path ends in a target's name. */
function key(root: string, target: string): string {
  return `${root}\u0000${target}`;
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
        const r = ref && this.running.get(key(ref.root, ref.target));
        if (r) {
          r.pid = e.processId;
          this.emitter.fire();
        }
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        const ref = this.taskRef(e.execution.task.definition as DayTaskDefinition);
        if (ref && this.running.delete(key(ref.root, ref.target))) {
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
    return root ? { root, target: def.target } : undefined;
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

  isRunning(root: string, target: string): boolean {
    const k = key(root, target);
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

  /** The targets running in one project. */
  runningIn(root: string): string[] {
    return this.runningRefs()
      .filter((r) => r.root === root)
      .map((r) => r.target);
  }

  private definition(command: "build" | "launch", root: string, target: string): DayTaskDefinition {
    const sel = this.state.selectionFor(root);
    return {
      type: "day",
      command,
      target,
      profile: sel.profile,
      locale: sel.locale || undefined,
      script: sel.script || undefined,
      project: root,
      device: sel.devices?.[target],
    };
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
      // was launched from the cockpit (a task) or the native Run UI (a debug session).
      if (this.isRunning(root, target)) {
        await this.stop(root, target);
      }
      const exec = await vscode.tasks.executeTask(
        buildDayTask(this.definition("launch", root, target)),
      );
      this.running.set(key(root, target), { ref: { root, target }, execution: exec });
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

  async stop(root: string, target: string): Promise<void> {
    const k = key(root, target);
    const r = this.running.get(k);
    if (r) {
      r.execution.terminate();
      this.running.delete(k);
      this.emitter.fire();
    }
    const d = this.debug.get(k);
    if (d) {
      await vscode.debug.stopDebugging(d);
      this.debug.delete(k);
      this.emitter.fire();
    }
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
