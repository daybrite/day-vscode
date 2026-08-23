// Native "Run and Debug" integration.
//
// Contributes the `day` debug type so F5 / Run → Start Debugging / the Run and Debug panel launch a
// Day app exactly like the cockpit's Run button — same selection (target, mode, locale, script,
// keep-alive). What happens next depends on what was asked for:
//
//   * "Start Debugging" on a DESKTOP target, with a Rust debugger installed, delegates: the app is
//     built, and `resolveDebugConfiguration` hands back a config of THAT debugger's type, pointed
//     at the binary. VS Code starts it instead of us, so breakpoints, stepping, and variable
//     inspection are the real thing — we never implement a debugger, we route to one.
//   * everything else (a device or browser target, "Run Without Debugging", no debugger installed)
//     runs through the launch-only inline adapter below: it spawns `day launch`, streams the
//     console into the Debug Console, and ends the session when the app exits.
//
// Owning no debug adapter is a deliberate constraint (PLAN.md): every framework extension that
// shipped its own rotted, and the ones that delegated survived.

import * as childProcess from "child_process";
import * as vscode from "vscode";

import { buildArgs, launchArgs, LaunchOptions, renderCommand, resolveCli } from "./cli";
import { Profile, Selection } from "./config";
import { DayProject } from "./project";
import { findTarget, isBuildableHere } from "./targets";
import { launchEnv, taskEnv, verbose } from "./tasks";

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
  /** Set by VS Code for "Run Without Debugging" (Ctrl+F5) — never delegate to a debugger then. */
  noDebug?: boolean;
}

/** `day build --format json`'s per-target `launch` object: how to start the built binary the way
 *  `day launch` would. The CLI is the only producer (ops.rs `desktop_launch_plan`) — the whole
 *  point is that the debugger inherits the same environment a normal run gets, so an app under a
 *  breakpoint finds its images, vectors, fonts, and identity exactly as it otherwise would. */
export interface DesktopLaunchPlan {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** A wrapper argv (`xvfb-run`) this host needs to give the app a display, if any. A debugger
   *  launches `program` itself and cannot run inside it — present means "warn, then try". */
  wrapper: string[] | null;
}

/** Which Rust debugger a delegated session is handed to. Mirrors the `day.debug.adapter` enum. */
export type DelegateKey = "lldb-dap" | "codelldb" | "cpptools";

export interface Delegate {
  key: DelegateKey;
  extensionId: string;
  label: string;
  /** The `type` the delegated config takes — the debug type VS Code will actually start. */
  debugType(): string;
  /** Shape a plan into that adapter's launch attributes. They agree on program/args/cwd and
   *  disagree on the environment, which is the only reason this is a function per delegate. */
  attributes(plan: DesktopLaunchPlan, env: Record<string, string>): Record<string, unknown>;
}

/** Probed in this order, which is rust-analyzer's: lldb-dap is the LLVM project's own adapter,
 *  CodeLLDB is the most widely installed, and cpptools is the fallback a Windows or C++ user
 *  already has. First one installed wins unless `day.debug.adapter` pins a choice. */
const DELEGATES: Delegate[] = [
  {
    key: "lldb-dap",
    extensionId: "llvm-vs-code-extensions.lldb-dap",
    label: "LLDB DAP",
    debugType: () => "lldb-dap",
    attributes: (plan, env) => ({ program: plan.program, args: plan.args, cwd: plan.cwd, env }),
  },
  {
    key: "codelldb",
    extensionId: "vadimcn.vscode-lldb",
    label: "CodeLLDB",
    debugType: () => "lldb",
    attributes: (plan, env) => ({ program: plan.program, args: plan.args, cwd: plan.cwd, env }),
  },
  {
    key: "cpptools",
    extensionId: "ms-vscode.cpptools",
    label: "C/C++",
    // A Rust binary from the MSVC toolchain carries a PDB, which is cppvsdbg's format; elsewhere
    // cpptools drives a real lldb/gdb over MI and needs to be told which.
    debugType: () => (process.platform === "win32" ? "cppvsdbg" : "cppdbg"),
    attributes: (plan, env) => ({
      program: plan.program,
      args: plan.args,
      cwd: plan.cwd,
      // cpptools takes name/value pairs rather than a map — the one real shape difference.
      environment: Object.entries(env).map(([name, value]) => ({ name, value })),
      ...(process.platform === "win32"
        ? {}
        : { MIMode: process.platform === "darwin" ? "lldb" : "gdb" }),
    }),
  },
];

/** One delegate by key, regardless of whether it is installed — the integration suite asserts each
 *  adapter's attribute shape, which is where a schema mismatch would otherwise surface as a failed
 *  debug session on someone else's machine. */
export function delegateByKey(key: DelegateKey): Delegate | undefined {
  return DELEGATES.find((d) => d.key === key);
}

/** The delegate to use, honoring the `day.debug.adapter` pin. `undefined` = debug through the
 *  launch-only adapter (nothing installed, or the user pinned "none"). */
export function pickDelegate(): Delegate | undefined {
  const pinned = vscode.workspace.getConfiguration("day").get<string>("debug.adapter") ?? "auto";
  if (pinned === "none") {
    return undefined;
  }
  const installed = (d: Delegate) => vscode.extensions.getExtension(d.extensionId) !== undefined;
  if (pinned !== "auto") {
    // A pin that names an uninstalled extension falls back rather than failing the launch: the
    // app still runs, and the notification below says why there are no breakpoints.
    const pick = DELEGATES.find((d) => d.key === pinned);
    return pick && installed(pick) ? pick : undefined;
  }
  return DELEGATES.find(installed);
}

/** The context the config provider reads from the running extension (the cockpit's live state). */
export interface DebugDeps {
  project: () => DayProject | undefined;
  selection: () => Selection;
  /** Targets ticked in the Day view that this host can build (extension.ts `selectedRunnable`). */
  runnableTargets: () => string[];
  keepAliveDefault: () => boolean;
  /** Restart semantics: drop any instance of this project's target already running, so F5
   *  relaunches rather than stacking a second one. */
  stopIfRunning: (root: string, target: string) => Promise<void>;
  /** The extension's "Day" output channel — where a delegated build's progress and failures go. */
  output: vscode.OutputChannel;
}

/**
 * Build `target` and return the launch plan the CLI computed for it.
 *
 * The build runs here as a child process rather than as a `preLaunchTask`, because the plan is
 * only available in `day build --format json`'s stdout — going through a task would mean building
 * twice, once for the terminal and once for the JSON. rust-analyzer's Debug lens resolves its
 * executable the same way (`cargo build --message-format=json`), for the same reason.
 *
 * Returns undefined when the build fails or the target reports no plan; the caller falls back to a
 * plain launch, so a debug session never leaves the user with nothing running.
 */
async function buildAndPlan(
  projectRoot: string,
  target: string,
  profile: Profile,
  output: vscode.OutputChannel,
): Promise<DesktopLaunchPlan | undefined> {
  const cli = resolveCli(projectRoot || undefined);
  const args = buildArgs(projectRoot, target, profile, verbose(projectRoot));
  // --format json ahead of the subcommand: it is a global flag, and the CLI keeps stdout clean for
  // the NDJSON stream while its own status lines go to stderr (which is what we echo below).
  const argv = [...cli.baseArgs, "--format", "json", ...args];
  output.appendLine(`$ ${renderCommand(cli, ["--format", "json", ...args])}`);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Day: building ${target}…` },
    () =>
      new Promise<DesktopLaunchPlan | undefined>((resolve) => {
        const child = childProcess.spawn(cli.command, argv, {
          cwd: cli.cwd ?? (projectRoot || undefined),
          env: { ...process.env, ...taskEnv(target) },
        });
        let stdout = "";
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
        child.on("error", (e) => {
          output.appendLine(`failed to run day: ${e.message}`);
          resolve(undefined);
        });
        child.on("exit", (code) => {
          if (code !== 0) {
            output.appendLine(`build failed (exit ${code})`);
            resolve(undefined);
            return;
          }
          resolve(planFrom(stdout, target, (m) => output.appendLine(m)));
        });
      }),
  );
}

/** Pull `target`'s launch plan out of a `day build --format json` NDJSON stream. Takes a plain
 *  logger rather than the output channel so the suite can exercise it on a captured stream. */
export function planFrom(
  stdout: string,
  target: string,
  log: (message: string) => void,
): DesktopLaunchPlan | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(text) as {
        event?: string;
        targets?: { target?: string; launch?: DesktopLaunchPlan }[];
      };
      if (event.event !== "result") {
        continue;
      }
      const entry = event.targets?.find((t) => t.target === target);
      if (entry?.launch?.program) {
        return entry.launch;
      }
      // A result event that names the target but carries no plan is the honest "this runtime has
      // no local process" case (a device or a browser) — not a parse problem.
      log(`no launch plan for ${target} — running without a debugger`);
      return undefined;
    } catch {
      // Not a result event; keep scanning older lines.
    }
  }
  log(`no result event in \`day build --format json\` output for ${target}`);
  return undefined;
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
      if (c.project) {
        await this.deps.stopIfRunning(c.project, c.target);
      }
      return this.delegate(folder, c as DayLaunchConfig);
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
    const root = this.deps.project()?.root;
    if (targets.length === 1) {
      if (root) {
        await this.deps.stopIfRunning(root, targets[0]);
      }
      return this.make(targets[0]); // single session, resolved inline
    }
    // Several targets → one session each (like the Run button), then suppress the placeholder.
    // Each started config names a target, so its re-resolution hits the branch above (no recursion).
    for (const t of targets) {
      if (root) {
        await this.deps.stopIfRunning(root, t);
      }
      void vscode.debug.startDebugging(folder, this.make(t));
    }
    return undefined;
  }

  /**
   * Turn a resolved `day` launch into a REAL debug session where that is possible: a desktop
   * target, an actual "Start Debugging", and an installed Rust debugger.
   *
   * **VS Code does not honor a `type` changed during resolution.** Returning a config whose type is
   * `lldb-dap` from a `day` provider resolves nothing and starts nothing — `startDebugging` simply
   * answers false. So the delegated session is started HERE, as its own top-level session, and this
   * one is aborted by returning `undefined` (which cancels quietly; `null` would open launch.json).
   * The multi-target branch above uses the same shape for the same reason.
   *
   * Every other case returns the config untouched, to run through the launch-only adapter. A
   * failure to delegate must never mean "nothing happened": the app still launches, and the reason
   * for the missing breakpoints is said out loud.
   */
  private async delegate(
    folder: vscode.WorkspaceFolder | undefined,
    cfg: DayLaunchConfig,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (cfg.noDebug) {
      return cfg; // "Run Without Debugging" — the launch-only adapter IS the run
    }
    if (findTarget(cfg.target)?.kind !== "desktop") {
      // Devices and browsers run under runtimes of their own; attaching to those is a separate
      // transport for each platform, and claiming otherwise here would be the "partial matrix
      // with a confident label" that PLAN.md warns about.
      return cfg;
    }
    const delegate = pickDelegate();
    if (!delegate) {
      void this.offerDebuggerInstall();
      return cfg;
    }
    const plan = await buildAndPlan(
      cfg.project ?? "",
      cfg.target,
      cfg.profile ?? "debug",
      this.deps.output,
    );
    if (!plan) {
      return cfg; // build failed, or the CLI reported no plan — run rather than start nothing
    }
    if (plan.wrapper) {
      void vscode.window.showWarningMessage(
        `No display on this host: \`day launch\` would wrap ${cfg.target} in \`${plan.wrapper.join(" ")}\`. ` +
          "A debugger starts the binary directly and cannot wrap it, so the app may fail to open a window.",
      );
    }
    if (cfg.script) {
      void vscode.window.showWarningMessage(
        `Dayscript "${cfg.script}" will not be driven: a debug session starts the app directly, while ` +
          "scripts are driven by `day launch`. Use Run Without Debugging to run the script.",
      );
    }
    // The locale and extra environment the cockpit would have passed as `--locale` / `--env`. A
    // plain `day build` knows neither, so the CLI's plan cannot carry them and they are layered
    // here — otherwise a debugged run would quietly differ from the same run through Run.
    const env: Record<string, string> = {
      ...plan.env,
      ...(cfg.locale ? { DAY_LOCALE: cfg.locale } : {}),
      ...launchEnv(cfg.project),
    };
    this.deps.output.appendLine(
      `debugging ${cfg.target} via ${delegate.label} (type ${delegate.debugType()}): ${plan.program}`,
    );
    const delegated: vscode.DebugConfiguration = {
      type: delegate.debugType(),
      request: "launch",
      name: cfg.name,
      ...delegate.attributes(plan, env),
    };
    // Not awaited: this call runs INSIDE a resolve, and waiting on a nested session start from
    // there is a good way to deadlock. Failure is reported rather than swallowed.
    void vscode.debug.startDebugging(folder, delegated).then((started) => {
      if (!started) {
        this.deps.output.appendLine(
          `${delegate.label} refused to start for ${cfg.target} — is the ${delegate.extensionId} extension enabled?`,
        );
        void vscode.window.showErrorMessage(
          `Could not start ${delegate.label} for ${cfg.target}. See the Day output channel (Day: Show Log).`,
        );
      }
    });
    return undefined;
  }

  /** Nudge once per session, with a one-click install. Repeating it every F5 would be the kind of
   *  notification users disable the extension over. */
  private static nudged = false;

  private async offerDebuggerInstall(): Promise<void> {
    if (DayConfigProvider.nudged) {
      return;
    }
    DayConfigProvider.nudged = true;
    const install = "Install LLDB DAP";
    const choice = await vscode.window.showInformationMessage(
      "Running without breakpoints — no Rust debugger extension is installed. Install one, then " +
        "Start Debugging again to stop on breakpoints in Rust.",
      install,
    );
    if (choice === install) {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        "llvm-vs-code-extensions.lldb-dap",
      );
    }
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
      env: launchEnv(cfg.project),
      verbose: verbose(cfg.project),
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
