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

/**
 * The `day` configuration as it applies to one project.
 *
 * `extraEnv`, `logLevel` and `verbose` are declared `resource`-scoped, so each app can carry its
 * own in `<project>/.vscode/settings.json` — one app logging at trace while the next stays quiet.
 * Passing the root is what makes VS Code apply that folder's value; without it every project would
 * read the window's.
 */
function dayConfig(root?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("day", configResource(root));
}

/**
 * The URI to read a project's folder-scoped settings against.
 *
 * Not simply `Uri.file(root)`: `day metadata` reports a canonical root (`/private/tmp/…` on
 * macOS) while the workspace folder keeps the path as opened (`/tmp/…`), and a URI VS Code cannot
 * place inside a folder silently falls back to the WINDOW's settings — so every project would
 * quietly share one log level. Matching through resolved paths puts each project back on its own.
 */
function configResource(root?: string): vscode.Uri | undefined {
  if (!root) {
    return undefined;
  }
  const direct = vscode.Uri.file(root);
  if (vscode.workspace.getWorkspaceFolder(direct)) {
    return direct;
  }
  const resolved = realPath(root);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const here = realPath(folder.uri.fsPath);
    if (resolved === here || resolved.startsWith(here.endsWith(path.sep) ? here : here + path.sep)) {
      return folder.uri;
    }
  }
  return direct;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Where a sidebar edit to a per-project setting is written.
 *
 * The project's own folder when it is one, so the Verbose checkbox and Log level row edit the app
 * they are pointed at. Otherwise the pre-existing rule: keep a workspace override a workspace
 * override, and put everything else in user settings rather than quietly pinning a value for one
 * workspace that the user set once, globally.
 */
function writeScope(
  cfg: vscode.WorkspaceConfiguration,
  key: string,
  root?: string,
): vscode.ConfigurationTarget {
  if (root && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  const info = cfg.inspect(key);
  return info?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export function extraEnv(root?: string): Record<string, string> {
  return dayConfig(root).get<Record<string, string>>("extraEnv") ?? {};
}

/** `DAY_LOG`'s level names, most to least verbose (day-vscode passes them through untouched). */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "off"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The `DAY_LOG` level a project's launches pass (`day.logLevel`). */
export function logLevel(root?: string): LogLevel {
  const v = dayConfig(root).get<string>("logLevel", "trace");
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "trace";
}

/** Set `day.logLevel` for one project (or the window, with no project). */
export async function setLogLevel(level: LogLevel, root?: string): Promise<void> {
  const cfg = dayConfig(root);
  await cfg.update("logLevel", level, writeScope(cfg, "logLevel", root));
}

/**
 * Environment for the launched app (each entry becomes `--env KEY=VALUE`): the configured log
 * level, then `day.extraEnv` — last wins, so a hand-written `DAY_LOG` there overrides
 * `day.logLevel`.
 */
export function launchEnv(root?: string): Record<string, string> {
  return { DAY_LOG: logLevel(root), ...extraEnv(root) };
}

/** Whether a project's builds and launches run with `--verbose` (day.verbose). */
export function verbose(root?: string): boolean {
  return dayConfig(root).get<boolean>("verbose", false);
}

/** Flip `day.verbose` for one project (see [`writeScope`]). Returns the new value. */
export async function toggleVerbose(root?: string): Promise<boolean> {
  const cfg = dayConfig(root);
  const next = !cfg.get<boolean>("verbose", false);
  await cfg.update("verbose", next, writeScope(cfg, "verbose", root));
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
          env: launchEnv(projectRoot),
          verbose: verbose(projectRoot),
        })
      : buildArgs(projectRoot, def.target, profile, verbose(projectRoot));

  const env = taskEnv(def.target);
  const exec = new vscode.ProcessExecution(cli.command, [...cli.baseArgs, ...args], {
    ...(cli.cwd ? { cwd: cli.cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  });
  // Always qualified by project, even with one app open. A task's name is its identity — it names
  // the terminal panel and the entry in the Tasks list — and two apps both building `macos-appkit`
  // would otherwise share one panel and one identity. Qualifying only when a second project
  // appears would instead rename a task the moment a folder is added, which is worse: the name
  // would be stable only as long as the workspace was.
  const verb = def.command === "launch" ? "run" : "build";
  const name = projectRoot
    ? `${verb} ${def.target} (${path.basename(projectRoot)})`
    : `${verb} ${def.target}`;
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
