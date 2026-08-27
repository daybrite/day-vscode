// Resolve how to invoke the `day` CLI, and build its argument vectors.
//
// Resolution order:
//   0. `day.cliSource` pointing at a day checkout → `cargo run` against it, so an edit to the CLI
//      is compiled into the very next build or launch. This is the CLI-development mode, and it
//      wins over everything below because that is the whole point of setting it;
//   1. an explicit `day.cliPath` set to something other than "day" → use it verbatim;
//   2. otherwise, if a Day checkout is in reach — the workspace is the Day repo (a Cargo workspace
//      with a `day-cli` member), or a `day/` repo sits beside this extension — use ITS CLI:
//      `target/debug/day` when that has been built, else `cargo run -q -p day-cli --` to build it;
//   3. otherwise `day` (expected on PATH).
//
// The built binary is preferred over `cargo run` because it needs nothing on the extension host's
// PATH. An extension host inherits the environment of whatever started VS Code — a window opened
// by an already-running instance carries that instance's PATH, which is why `cargo run` could fail
// with ENOENT on a machine where cargo is plainly installed, and the extension would then report a
// missing `day` CLI and offer to install one it did not need.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// Where this extension is loaded from, captured once at activation. When it runs from source
// beside a `day/` checkout (an `--extensionDevelopmentPath` dev host in the daybrite monorepo),
// `resolveCli` can build the CLI straight from that peer repo — see `findPeerDayRepo`.
let extensionRoot: string | undefined;

/** Record the extension's own directory (call once from `activate`). */
export function setExtensionRoot(dir: string): void {
  extensionRoot = dir;
}

export interface DayCli {
  /** The executable to spawn (e.g. "day" or "cargo"). */
  command: string;
  /** Args that precede the day subcommand (e.g. ["run","-q","-p","day-cli","--"] for the fallback). */
  baseArgs: string[];
  /** Working directory for the process (the day repo root, for the cargo fallback). */
  cwd?: string;
  /** A human-readable rendering of the resolved command, for logs/tooltips. */
  display: string;
}

/** Walk up from `start` (and across workspace roots) to a dir containing `crates/day-cli/Cargo.toml`. */
export function findDayRepoRoot(start?: string): string | undefined {
  const seeds: string[] = [];
  if (start) {
    seeds.push(start);
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    seeds.push(f.uri.fsPath);
  }
  for (const seed of seeds) {
    let dir = seed;
    // Bound the walk to avoid touching the whole filesystem.
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(dir, "crates", "day-cli", "Cargo.toml"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

/** If this extension sits beside a local `day/` repo checkout (…/day-vscode next to …/day),
 *  return that repo's root. Matches only a real checkout — a Cargo workspace carrying the
 *  `day-cli` member — so an installed extension under `~/.vscode/extensions` never trips it. */
export function findPeerDayRepo(): string | undefined {
  if (!extensionRoot) {
    return undefined;
  }
  const peer = path.join(path.dirname(extensionRoot), "day");
  const looksLikeDayRepo =
    fs.existsSync(path.join(peer, "Cargo.toml")) &&
    fs.existsSync(path.join(peer, "crates", "day-cli", "Cargo.toml"));
  return looksLikeDayRepo ? peer : undefined;
}

/** An already-built `day` binary inside `repo`, if there is one.
 *
 *  Honours CARGO_TARGET_DIR, and prefers debug over release: debug is what `cargo run -q` and the
 *  `scripts/dev.*` launchers produce, so it is the build a dev host is meant to be driving.
 */
export function findBuiltDayBinary(repo: string): string | undefined {
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(repo, "target");
  const exe = process.platform === "win32" ? "day.exe" : "day";
  for (const profile of ["debug", "release"]) {
    const candidate = path.join(targetDir, profile, exe);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** How to invoke the CLI of a checkout: its built binary if there is one, else cargo. */
function checkoutCli(
  repo: string,
  cargoArgs: string[],
  cargoDisplay: string,
): DayCli {
  const built = findBuiltDayBinary(repo);
  if (built) {
    // No cwd: the caller runs it in the project directory, exactly as an installed `day` would be.
    // A day-cli source edit is picked up by rebuilding it (the dev scripts do that on every run),
    // not by this call — the trade for not paying a cargo lock on every metadata refresh.
    return { command: built, baseArgs: [], display: built };
  }
  // cwd is the repo root, so cargo reads that workspace's `.cargo/config`, not the target
  // project's.
  return {
    command: "cargo",
    baseArgs: cargoArgs,
    cwd: repo,
    display: cargoDisplay,
  };
}

/** Expand a leading `~`, which a hand-written settings path very often carries. */
function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A day source checkout: a Cargo workspace that actually carries the `day-cli` member. */
function isDayCheckout(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "Cargo.toml")) &&
    fs.existsSync(path.join(dir, "crates", "day-cli", "Cargo.toml"))
  );
}

/** Whether `cargo` can be spawned at all, resolved the way the shell would and cached per session.
 *
 *  An extension host inherits the environment of whatever started VS Code — a window opened by an
 *  already-running instance carries THAT instance's PATH, which frequently lacks `~/.cargo/bin`.
 *  Checking up front lets `day.cliSource` fall back to the checkout's built binary instead of
 *  failing every CLI call with ENOENT. */
let cargoOnPath: boolean | undefined;
function hasCargo(): boolean {
  if (cargoOnPath === undefined) {
    const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    // `~/.cargo/bin` is where rustup puts it, and is the entry most often missing from a GUI PATH.
    dirs.push(path.join(os.homedir(), ".cargo", "bin"));
    cargoOnPath = dirs.some((d) => fs.existsSync(path.join(d, exe)));
  }
  return cargoOnPath;
}

/** Warned once per session, because `resolveCli` runs on every CLI invocation. */
let warnedAboutSource = false;
function warnOnce(message: string): void {
  if (!warnedAboutSource) {
    warnedAboutSource = true;
    void vscode.window.showWarningMessage(message);
  }
}

export function resolveCli(projectDir?: string): DayCli {
  const cfg = vscode.workspace.getConfiguration("day");
  const cliPath = (cfg.get<string>("cliPath") ?? "day").trim();

  // CLI-development mode: run the CLI from source on every invocation, so a change to day-cli is
  // in the next build without anyone remembering to rebuild it.
  const source = (cfg.get<string>("cliSource") ?? "").trim();
  if (source) {
    const repo = expandHome(source);
    if (!isDayCheckout(repo)) {
      warnOnce(
        `Day: day.cliSource does not look like a day checkout (no crates/day-cli/Cargo.toml under ${repo}) — ignoring it.`,
      );
    } else if (!hasCargo()) {
      // Falling back rather than failing: the built binary in that same tree is what the dev
      // scripts leave behind, so the window still works — just without picking up CLI edits.
      const built = findBuiltDayBinary(repo);
      warnOnce(
        built
          ? `Day: day.cliSource is set but \`cargo\` is not on the extension host's PATH — using ${built}, which will not pick up day-cli edits.`
          : `Day: day.cliSource is set but \`cargo\` is not on the extension host's PATH, and ${repo} has no built CLI to fall back to.`,
      );
      if (built) {
        return { command: built, baseArgs: [], display: built };
      }
    } else {
      const manifest = path.join(repo, "Cargo.toml");
      const baseArgs = [
        "run",
        "--manifest-path",
        manifest,
        "-q",
        "-p",
        "day-cli",
        "--",
      ];
      // cwd is the checkout, so cargo reads THAT workspace's config rather than the app's.
      return {
        command: "cargo",
        baseArgs,
        cwd: repo,
        display: `cargo ${baseArgs.join(" ")}`,
      };
    }
  }

  if (cliPath && cliPath !== "day") {
    return { command: cliPath, baseArgs: [], display: cliPath };
  }

  const repo = findDayRepoRoot(projectDir);
  if (repo) {
    return checkoutCli(
      repo,
      ["run", "-q", "-p", "day-cli", "--"],
      "cargo run -q -p day-cli --",
    );
  }

  // Dev-host convenience: the extension runs from a `day-vscode/` checkout beside a `day/` repo,
  // but the open project lives outside that repo (e.g. a sibling `Day-Games/`). Take the CLI from
  // the peer repo — built binary first, else cargo against its manifest — so its projects load
  // with no installed `day` on PATH.
  const peer = findPeerDayRepo();
  if (peer) {
    const manifest = path.join(peer, "Cargo.toml");
    return checkoutCli(
      peer,
      ["run", "--manifest-path", manifest, "-q", "-p", "day-cli", "--"],
      `cargo run --manifest-path ${manifest} -q -p day-cli --`,
    );
  }

  return { command: "day", baseArgs: [], display: "day" };
}

export interface LaunchOptions {
  projectRoot: string;
  target: string;
  profile: "debug" | "release";
  locale?: string;
  script?: string;
  /** Keep the app running after its dayscript completes (interactive script development). */
  keepAlive?: boolean;
  env?: Record<string, string>;
  /** Show every sub-command the CLI runs, and its raw output, instead of day's status lines. */
  verbose?: boolean;
  /** The device to launch onto. Omitted means every connected one, the CLI's own default. */
  device?: { id: string; flag: string };
}

function projectArgs(projectRoot: string): string[] {
  // Omit --project when unknown so the CLI falls back to cwd-based Day.toml discovery.
  return projectRoot && projectRoot.length > 0
    ? ["--project", projectRoot]
    : [];
}

/** Args for `day launch` (a single target). */
export function launchArgs(o: LaunchOptions): string[] {
  const args = [
    ...projectArgs(o.projectRoot),
    "launch",
    "-p",
    o.target,
    "--profile",
    o.profile,
  ];
  if (o.locale && o.locale.length > 0) {
    args.push("--locale", o.locale);
  }
  if (o.script && o.script.length > 0) {
    args.push("--script", o.script);
    if (o.keepAlive) {
      args.push("--keep-alive");
    }
  }
  for (const [k, v] of Object.entries(o.env ?? {})) {
    args.push("--env", `${k}=${v}`);
  }
  if (o.verbose) {
    args.push("--verbose");
  }
  // The flag comes from the listing rather than from the target: iOS needs `--ios-simulator` for a
  // booted simulator and `--ios-device` for a plugged-in phone, and only the CLI knows which.
  if (o.device) {
    args.push(o.device.flag, o.device.id);
  }
  return args;
}

/** Args for `day build` (a single target). */
export function buildArgs(
  projectRoot: string,
  target: string,
  profile: "debug" | "release",
  verbose = false,
): string[] {
  const args = [
    ...projectArgs(projectRoot),
    "build",
    "-p",
    target,
    "--profile",
    profile,
  ];
  if (verbose) {
    args.push("--verbose");
  }
  return args;
}

/**
 * Args for `day lint --json`.
 *
 * `--project` is not optional decoration here: with `day.cliSource` set the command runs as
 * `cargo run --manifest-path <checkout>` with the CHECKOUT as its cwd, so cwd-based `Day.toml`
 * discovery would find day's own repo — or nothing — instead of the app.
 */
export function lintArgs(projectRoot: string): string[] {
  return [...projectArgs(projectRoot), "lint", "--json"];
}

/**
 * The provider id `package.json` contributes under `mcpServerDefinitionProviders`, and the id
 * `registerMcpServerDefinitionProvider` registers with. VS Code matches the two by string, and a
 * mismatch is silent — the provider is simply never asked, and agent mode shows no Day tools with
 * nothing logged anywhere — so both sides read it from here.
 */
export const MCP_PROVIDER_ID = "day";

/** Args for `day mcp-server`, which serves one project to an agent over stdio (docs/agent.md). */
export function mcpServerArgs(projectRoot: string): string[] {
  return [...projectArgs(projectRoot), "mcp-server"];
}

/** How to spawn one Day MCP server. */
export interface McpServerSpec {
  /** What names this server in VS Code's MCP list — and how an agent picks between projects. */
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Extra environment for the server process. */
  env: Record<string, string>;
}

/** As much of a Day project's identity as the MCP wiring needs. */
export interface McpProject {
  root: string;
  name: string;
  title?: string;
}

/** Last path segment, on either separator — `path.basename` returns the whole string when handed
 *  a Windows path on a POSIX host, which is exactly the case a test exercises. */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Server labels, one per project, disambiguated when two apps share a display name.
 *
 * Two identically-named entries in the MCP list would reintroduce the very ambiguity these labels
 * exist to remove, and it is not hypothetical — a window can hold two checkouts of the same app.
 */
function mcpLabels(projects: McpProject[]): string[] {
  const display = projects.map((p) => p.title?.trim() || p.name);
  const counts = new Map<string, number>();
  for (const d of display) {
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return projects.map((p, i) =>
    (counts.get(display[i]) ?? 0) > 1
      ? `Day: ${display[i]} (${baseName(p.root)})`
      : `Day: ${display[i]}`,
  );
}

/**
 * One MCP server per Day project in the window — empty when `day.mcp.enabled` is off, or when the
 * window holds no Day project.
 *
 * Every server is bound to a single project at spawn, because `day mcp-server` takes `--project`
 * and its tools take no project argument. Serving only the FOCUSED project therefore silently
 * misdirects any agent asked about a second app in the same window: `day_launch` builds the
 * focused app instead, and `day_running` reports no sessions for an app the user can see running,
 * because the session registry lives at `<root>/build/day/sessions.json` and is read under the
 * bound root. Naming each server after its project is what lets an agent pick the right one.
 *
 * Kept out of the provider registration in `extension.ts` because everything that can be wrong
 * here is a plain value: which project each server reports on, the labels that tell them apart,
 * the cwd a `day.cliSource` checkout needs, and whether the setting is honoured at all.
 */
export function mcpServerSpecs(projects: McpProject[]): McpServerSpec[] {
  const enabled = vscode.workspace
    .getConfiguration("day")
    .get<boolean>("mcp.enabled", true);
  if (!enabled) {
    return [];
  }
  const labels = mcpLabels(projects);
  return projects.map((project, i) => {
    const cli = resolveCli(project.root);
    return {
      label: labels[i],
      command: cli.command,
      args: [...cli.baseArgs, ...mcpServerArgs(project.root)],
      cwd: cli.cwd,
      env: selfCommandEnv(cli),
    };
  });
}

/**
 * How the server should re-invoke the CLI for each tool call, when that is not simply the binary
 * it is already running as.
 *
 * `day mcp-server` shells back into the CLI for every tool, and by default that means its own
 * executable. In a `day.cliSource` window the CLI is `cargo run` against the open `day/` checkout,
 * and the server's executable is the `target/debug/day` cargo produced when the server STARTED —
 * so without this, a day-cli edit would reach the editor's Build and Run commands but not the
 * agent's tools, and the same window would be running two different CLIs. Working on `day/` and an
 * app together in one session is exactly what `scripts/dev.sh` sets up, so the two must agree.
 *
 * Empty for a plain binary, where the server's own executable is already the right answer.
 */
function selfCommandEnv(cli: DayCli): Record<string, string> {
  return cli.baseArgs.length > 0
    ? { DAY_SELF_COMMAND: JSON.stringify([cli.command, ...cli.baseArgs]) }
    : {};
}

/** A shell-safe rendering of a command for display in a terminal/log line. */
export function renderCommand(cli: DayCli, args: string[]): string {
  const all = [cli.command, ...cli.baseArgs, ...args];
  return all.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
