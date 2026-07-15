// Native "Run and Debug" integration (Tier 1: launch-only, no debugger).
//
// Contributes the `day` debug type so F5 / Run → Start Debugging / the Run and Debug panel launch a
// Day app exactly like the cockpit's Run button — same `day launch` invocation, same selection
// (target, mode, locale, script, keep-alive). There is no debugger: the inline adapter just spawns
// `day launch`, streams its console output into the Debug Console, and ends the session when the
// app exits (or when the user hits Stop, which SIGTERMs the CLI — whose own handler tears the app
// down). Rust breakpoint debugging is deliberately out of scope here.

import * as childProcess from "child_process";
import * as vscode from "vscode";

import { launchArgs, LaunchOptions, renderCommand, resolveCli } from "./cli";
import { Profile, Selection } from "./config";
import { DayProject } from "./project";
import { findTarget, isBuildableHere } from "./targets";
import { extraEnv, taskEnv } from "./tasks";

/** A `day` launch configuration (mirrors the launch fields of DayTaskDefinition). */
export interface DayLaunchConfig extends vscode.DebugConfiguration {
  type: "day";
  request: "launch";
  target: string;
  profile?: Profile;
  locale?: string;
  script?: string;
  keepAlive?: boolean;
  project?: string;
}

/** The context the config provider reads from the running extension (the cockpit's live state). */
export interface DebugDeps {
  project: () => DayProject | undefined;
  selection: () => Selection;
  /** Targets ticked in the Day view that this host can build (extension.ts `selectedRunnable`). */
  runnableTargets: () => string[];
  keepAliveDefault: () => boolean;
  /** Restart semantics: drop any instance already running for this target before relaunching. */
  stopIfRunning: (target: string) => Promise<void>;
}

/**
 * Supplies `day` launch configs (for the dynamic Run dropdown and `launch.json` authoring) and
 * fills in a bare F5 from the cockpit selection — so running with no `launch.json` does exactly
 * what the cockpit Run button does.
 */
export class DayConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly deps: DebugDeps) {}

  private make(target: string): DayLaunchConfig {
    const sel = this.deps.selection();
    return {
      type: "day",
      request: "launch",
      name: `Day: Run ${target}`,
      target,
      profile: sel.profile,
      ...(sel.locale ? { locale: sel.locale } : {}),
      ...(sel.script ? { script: sel.script } : {}),
      keepAlive: this.deps.keepAliveDefault(),
      project: this.deps.project()?.root,
    };
  }

  /** Dynamic Run dropdown + "Add Configuration": one launch per declared/selected target. */
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    const project = this.deps.project();
    const targets =
      project?.targets && project.targets.length > 0 ? project.targets : this.deps.runnableTargets();
    if (targets.length === 0) {
      return [{ type: "day", request: "launch", name: "Day: Run", target: "" } as DayLaunchConfig];
    }
    return targets.map((t) => this.make(t));
  }

  /**
   * Resolve a launch. The decision is driven by whether a usable `target` is present — NOT by
   * whether `type` is set — because the "Run and Debug" button synthesizes a `{type:"day",
   * request:"launch"}` config with no target, exactly like a bare F5's empty object. Any config
   * lacking a concrete target mirrors the cockpit Run button: launch the ticked targets (prompting
   * for one if none are ticked). A config that names a target is honored directly.
   */
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    const c = config as Partial<DayLaunchConfig>;

    // A named target (from launch.json or the dynamic list): honor it, filling cockpit defaults.
    if (c.target && c.target.length > 0) {
      c.type = "day";
      c.request = "launch";
      c.name ??= `Day: Run ${c.target}`;
      c.profile ??= this.deps.selection().profile;
      if (c.keepAlive === undefined) {
        c.keepAlive = this.deps.keepAliveDefault();
      }
      c.project ??= this.deps.project()?.root;
      await this.deps.stopIfRunning(c.target);
      return c as DayLaunchConfig;
    }

    // No target — the "Run and Debug" button / bare F5: launch the ticked targets, or prompt when
    // none are ticked so the button always leads somewhere.
    let targets = this.deps.runnableTargets();
    if (targets.length === 0) {
      const picked = await this.promptTargets();
      if (!picked || picked.length === 0) {
        return undefined; // cancelled — abort quietly
      }
      targets = picked;
    }
    if (targets.length === 1) {
      await this.deps.stopIfRunning(targets[0]);
      return this.make(targets[0]); // single session, resolved inline
    }
    // Several targets → one session each (like the Run button), then suppress the placeholder.
    // Each started config names a target, so its re-resolution hits the branch above (no recursion).
    for (const t of targets) {
      await this.deps.stopIfRunning(t);
      void vscode.debug.startDebugging(folder, this.make(t));
    }
    return undefined;
  }

  /** When nothing is ticked in the Day view, ask which target(s) to run. */
  private async promptTargets(): Promise<string[] | undefined> {
    const project = this.deps.project();
    const buildable = (project?.targets ?? []).filter((name) => {
      const t = findTarget(name);
      return !t || isBuildableHere(t);
    });
    if (buildable.length === 0) {
      void vscode.window.showInformationMessage(
        "This Day project has no targets buildable on this host.",
      );
      return undefined;
    }
    if (buildable.length === 1) {
      return buildable; // nothing to choose
    }
    const picks = await vscode.window.showQuickPick(
      buildable.map((name) => ({ label: name })),
      { canPickMany: true, title: "Day: Run", placeHolder: "Pick the target(s) to run" },
    );
    return picks?.map((p) => p.label);
  }
}

/** Hands VS Code an inline (in-process) adapter for each `day` debug session. */
export class DayDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new DayLaunchAdapter());
  }
}

/**
 * A minimal Debug Adapter Protocol implementation that runs — but does not debug — a Day app. It
 * answers just enough of the protocol for VS Code to show a live session (initialize/launch/threads/
 * disconnect), spawns `day launch`, and pipes stdout/stderr into the Debug Console. The session ends
 * when the CLI exits; Stop sends SIGTERM, whose CLI-side handler terminates the app and its watchers.
 */
class DayLaunchAdapter implements vscode.DebugAdapter {
  private readonly sender = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sender.event;
  private seq = 1;
  private child?: childProcess.ChildProcess;
  private ended = false;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as { type: string; seq: number; command?: string; arguments?: unknown };
    if (msg.type !== "request") {
      return;
    }
    switch (msg.command) {
      case "initialize":
        // No debugger — advertise only that we can be terminated cleanly.
        this.respond(msg, { supportsTerminateRequest: true, supportsConfigurationDoneRequest: true });
        this.send({ type: "event", event: "initialized" });
        break;
      case "launch":
        this.launch(msg.arguments as DayLaunchConfig, msg);
        break;
      case "configurationDone":
        this.respond(msg);
        break;
      case "threads":
        // VS Code always asks; hand back one dummy so the UI is happy.
        this.respond(msg, { threads: [{ id: 1, name: "day" }] });
        break;
      case "disconnect":
      case "terminate":
        this.kill();
        this.respond(msg);
        break;
      default:
        this.respond(msg); // ack anything else we don't implement
    }
  }

  private launch(cfg: DayLaunchConfig, req: { seq: number; command?: string }): void {
    const cli = resolveCli(cfg.project || undefined);
    const opts: LaunchOptions = {
      projectRoot: cfg.project ?? "",
      target: cfg.target,
      profile: cfg.profile ?? "debug",
      locale: cfg.locale,
      script: cfg.script,
      keepAlive: cfg.keepAlive,
      env: extraEnv(),
    };
    const dayArgs = launchArgs(opts);
    const args = [...cli.baseArgs, ...dayArgs];
    this.output(`${renderCommand(cli, dayArgs)}\n`, "console");

    const env = { ...process.env, ...taskEnv(cfg.target) };
    const child = childProcess.spawn(cli.command, args, {
      cwd: cli.cwd ?? (cfg.project || undefined),
      env,
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.output(d.toString(), "stdout"));
    child.stderr?.on("data", (d: Buffer) => this.output(d.toString(), "stderr"));
    child.on("error", (e) => {
      this.output(`failed to run day: ${e.message}\n`, "stderr");
      this.exit(1);
    });
    child.on("exit", (code, signal) => this.exit(code ?? (signal ? 143 : 0)));
    this.respond(req);
  }

  private kill(): void {
    if (this.child && this.child.exitCode === null) {
      // The CLI treats SIGTERM as "stop": its handler kills the launched app and any log watchers.
      this.child.kill("SIGTERM");
    }
  }

  private exit(code: number): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.send({ type: "event", event: "exited", body: { exitCode: code } });
    this.send({ type: "event", event: "terminated" });
  }

  private respond(req: { seq: number; command?: string }, body?: unknown): void {
    this.send({ type: "response", request_seq: req.seq, success: true, command: req.command, body });
  }

  private output(text: string, category: "stdout" | "stderr" | "console"): void {
    this.send({ type: "event", event: "output", body: { category, output: text } });
  }

  private send(partial: Record<string, unknown>): void {
    this.sender.fire({ seq: this.seq++, ...partial } as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    this.kill();
  }
}
