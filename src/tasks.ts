// Construct a vscode.Task for a `day` build/launch. Shared by the runner (which builds a definition
// from the current selection) and the TaskProvider (which resolves a definition from tasks.json), so
// interactive runs and hand-written tasks behave identically.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { buildArgs, launchArgs, renderCommand, resolveCli } from "./cli";
import { Profile } from "./config";
import { findTarget } from "./targets";

export interface DayTaskDefinition extends vscode.TaskDefinition {
  type: "day";
  command: "build" | "launch";
  target: string;
  profile?: Profile;
  locale?: string;
  script?: string;
  /** Keep the app running after its dayscript completes (default: day.script.keepAppRunning). */
  keepAlive?: boolean;
  project?: string;
}

export function extraEnv(): Record<string, string> {
  return vscode.workspace.getConfiguration("day").get<Record<string, string>>("extraEnv") ?? {};
}

/** `DAY_LOG`'s level names, most to least verbose (day-vscode passes them through untouched). */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "off"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The `DAY_LOG` level every launch passes (`day.logLevel`). */
export function logLevel(): LogLevel {
  const v = vscode.workspace.getConfiguration("day").get<string>("logLevel", "trace");
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "trace";
}

/** Set `day.logLevel`, at the scope that currently supplies it (the `toggleVerbose` rule). */
export async function setLogLevel(level: LogLevel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("day");
  const info = cfg.inspect<string>("logLevel");
  const target =
    info?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await cfg.update("logLevel", level, target);
}

/**
 * Environment for the launched app (each entry becomes `--env KEY=VALUE`): the configured log
 * level, then `day.extraEnv` — last wins, so a hand-written `DAY_LOG` there overrides
 * `day.logLevel`.
 */
export function launchEnv(): Record<string, string> {
  return { DAY_LOG: logLevel(), ...extraEnv() };
}

/** Whether builds and launches run with `--verbose` (day.verbose). */
export function verbose(): boolean {
  return vscode.workspace.getConfiguration("day").get<boolean>("verbose", false);
}

/**
 * Flip `day.verbose`, for the Configuration checkbox in the Day view. Returns the new value.
 *
 * Written at the scope that currently SUPPLIES the value, as `day.toggleScriptKeepAlive` does:
 * a workspace override stays a workspace override, and everything else lands in user settings.
 * Always writing the workspace would quietly pin a per-project value for someone who had set it
 * once, globally, and wondered why the next project ignored it.
 */
export async function toggleVerbose(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration("day");
  const next = !cfg.get<boolean>("verbose", false);
  const info = cfg.inspect<boolean>("verbose");
  const target =
    info?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await cfg.update("verbose", next, target);
  return next;
}

/** Expand a leading `~` (settings values are often written that way). */
function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Process environment for the task itself (NOT the launched app — that's `extraEnv`/`--env`).
 * The `harmony-arkui` target needs `OHOS_NDK_HOME` at BUILD time (day-arkui-sys compiles its C++ shim
 * with the NDK clang), and a GUI-launched VS Code usually doesn't carry it. Resolve it from the
 * `day.ohosNdkHome` setting or the common install locations, and put the SDK's sibling
 * `toolchains/` (hdc) on the task PATH. Returns {} for non-OHOS targets, deferring to the parent
 * environment.
 */
export function taskEnv(target: string): Record<string, string> {
  if (findTarget(target)?.kind !== "harmonyOs") {return {};}
  const configured = vscode.workspace.getConfiguration("day").get<string>("ohosNdkHome") ?? "";
  const candidates = [
    expandHome(configured),
    process.env.OHOS_NDK_HOME ?? "",
    path.join(os.homedir(), "ohos/ndk-extract/native"),
    path.join(os.homedir(), "ohos-sdk/native"),
  ].filter((c) => c.length > 0);
  const ndk = candidates.find((c) => fs.existsSync(path.join(c, "llvm", "bin")));
  if (!ndk) {return {};} // let the day CLI report what to install
  const env: Record<string, string> = { OHOS_NDK_HOME: ndk };
  const toolchains = path.join(path.dirname(ndk), "toolchains");
  if (fs.existsSync(toolchains)) {
    env.PATH = `${toolchains}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  return env;
}

export function buildDayTask(
  def: DayTaskDefinition,
  opts?: { projectFallback?: string },
): vscode.Task {
  const projectRoot = def.project ?? opts?.projectFallback ?? "";
  const cli = resolveCli(projectRoot || undefined);
  const profile: Profile = def.profile ?? "debug";

  const args =
    def.command === "launch"
      ? launchArgs({
          projectRoot,
          target: def.target,
          profile,
          locale: def.locale,
          script: def.script,
          // Interactive script development: keep the app open when its script finishes so the
          // script can be extended and re-driven against the live app (day.script.keepAppRunning).
          keepAlive:
            def.keepAlive ??
            vscode.workspace.getConfiguration("day").get<boolean>("script.keepAppRunning", true),
          env: launchEnv(),
          verbose: verbose(),
        })
      : buildArgs(projectRoot, def.target, profile, verbose());

  const env = taskEnv(def.target);
  const exec = new vscode.ProcessExecution(cli.command, [...cli.baseArgs, ...args], {
    ...(cli.cwd ? { cwd: cli.cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  });
  const name = def.command === "launch" ? `run ${def.target}` : `build ${def.target}`;
  // $day-rustc is contributed by THIS extension (a $rustc it can rely on: the stock name only
  // exists when rust-analyzer is installed, and an unknown matcher name is silently ignored).
  // Launches compile first, so they get the matcher too.
  const matchers = ["$day-rustc"];

  const task = new vscode.Task(def, vscode.TaskScope.Workspace, name, "day", exec, matchers);
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    // A dedicated panel per task identity: each target keeps its own terminal, reused on restart.
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    focus: false,
    showReuseMessage: false,
  };
  task.detail = renderCommand(cli, args);
  return task;
}
