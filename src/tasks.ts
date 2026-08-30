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
  /** Device to launch onto, as `day devices list` described it. Omitted = every connected one. */
  device?: { id: string; flag: string };
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
  // Through `configResource`, not `Uri.file(root)`: the read side already resolves the two
  // spellings of a symlinked path, and a write that did not would land in USER settings while the
  // row went on reading the folder's — a toggle that silently became window-wide.
  const resource = configResource(root);
  if (resource && vscode.workspace.getWorkspaceFolder(resource)) {
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
  const v = dayConfig(root).get<string>("logLevel", "debug");
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "debug";
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

/**
 * Whether the Day view leaves out the targets this host cannot build
 * (`day.hideUnavailableTargets`).
 *
 * Folder-scoped like the rest: a Windows-only app in the same window as a cross-platform one can
 * list what it ships to while the other stays trimmed to what runs here.
 */
export function hideUnavailableTargets(root?: string): boolean {
  return dayConfig(root).get<boolean>("hideUnavailableTargets", true);
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
 * `day.harmonyNDKHome` setting or the common install locations, and put the SDK's sibling
 * `toolchains/` (hdc) on the task PATH. Returns {} for non-OHOS targets, deferring to the parent
 * environment.
 */
export function taskEnv(target: string): Record<string, string> {
  const env = toolchainEnv();
  const ndk = ohosNdk();
  if (findTarget(target)?.kind === "harmonyOs" && ndk) {
    env.OHOS_NDK_HOME = ndk;
    // `hdc` ships in the SDK's sibling toolchains/ dir rather than in `native`, and every
    // install/launch shells out to it.
    prependPath(env, path.join(path.dirname(ndk), "toolchains"));
  }
  return env;
}

/**
 * The OpenHarmony `native` dir: the setting, then the environment, then the usual install spots.
 * `undefined` when none of them holds an NDK, so the CLI reports what to install rather than
 * being handed a path that does not exist.
 */
function ohosNdk(): string | undefined {
  const configured = vscode.workspace.getConfiguration("day").get<string>("harmonyNDKHome") ?? "";
  return [
    expandHome(configured),
    process.env.OHOS_NDK_HOME ?? "",
    path.join(os.homedir(), "ohos/ndk-extract/native"),
    path.join(os.homedir(), "ohos-sdk/native"),
  ]
    .filter((c) => c.length > 0)
    .find((c) => fs.existsSync(path.join(c, "llvm", "bin")));
}

/**
 * Toolchain locations from settings, as the environment variables the tools actually read.
 *
 * Applied to EVERY `day` command the extension runs — builds, launches, `day doctor`, device
 * listing — because a GUI-launched VS Code inherits the login environment, which frequently has
 * none of these. Doctor especially: it exists to report what is installed, and reporting against a
 * different SDK than the one builds will use would be worse than not reporting at all.
 *
 * Set unconditionally rather than per target: naming an Android SDK cannot confuse an iOS build,
 * and gating each variable on the target would mean `day doctor`, which checks every toolkit at
 * once, could only ever see one of them.
 */
export function toolchainEnv(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration("day");
  const env: Record<string, string> = {};
  const read = (key: string): string | undefined => {
    const v = (cfg.get<string>(key) ?? "").trim();
    return v.length > 0 ? expandHome(v) : undefined;
  };

  const sdk = read("androidSDKHome");
  if (sdk) {
    // BOTH spellings: `ANDROID_HOME` is what day-toolchain reads first, `ANDROID_SDK_ROOT` is
    // what Google's own tooling prefers, and a machine where the two disagree is a machine where
    // the build and the emulator use different SDKs.
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
    // adb and the emulator live here; putting them on PATH is what lets `day devices` find them
    // when the editor's environment does not already.
    prependPath(env, path.join(sdk, "platform-tools"));
    prependPath(env, path.join(sdk, "emulator"));
  }
  const ndk = read("androidNDKHome");
  if (ndk) {
    env.ANDROID_NDK_HOME = ndk;
  }
  const developer = read("xcodeDeveloperDirectory");
  if (developer) {
    env.DEVELOPER_DIR = developerDir(developer);
  }
  return env;
}

/**
 * `DEVELOPER_DIR` from whatever the setting points at.
 *
 * Read by `xcrun`, `xcodebuild` and `simctl` themselves — Day never looks at it — so this is how a
 * machine with several Xcodes points every Apple target at one of them. The `.app` is what a person
 * picks in Finder, but the variable wants the Developer dir inside it; taking either spelling beats
 * failing with "cannot find utility" over a trailing path segment. A trailing separator, which
 * shell completion adds, names the same bundle.
 *
 * Joined with `path.posix` rather than `path`: an Xcode path is a macOS path wherever the EDITOR
 * happens to be running, and the host-sensitive join turned it into
 * `\Applications\Xcode.app\Contents\Developer` on the Windows CI leg.
 */
function developerDir(setting: string): string {
  const bundle = setting.replace(/[/\\]+$/, "");
  return bundle.endsWith(".app") ? path.posix.join(bundle, "Contents", "Developer") : setting;
}

/** Prepend `dir` to the env's PATH, building on the process PATH the first time. */
function prependPath(env: Record<string, string>, dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const current = env.PATH ?? process.env.PATH ?? "";
  env.PATH = `${dir}${path.delimiter}${current}`;
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
          device: def.device,
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
