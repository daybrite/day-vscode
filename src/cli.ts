// Resolve how to invoke the `day` CLI, and build its argument vectors.
//
// Resolution order for the default `day.cliPath` ("day"):
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
function checkoutCli(repo: string, cargoArgs: string[], cargoDisplay: string): DayCli {
  const built = findBuiltDayBinary(repo);
  if (built) {
    // No cwd: the caller runs it in the project directory, exactly as an installed `day` would be.
    // A day-cli source edit is picked up by rebuilding it (the dev scripts do that on every run),
    // not by this call — the trade for not paying a cargo lock on every metadata refresh.
    return { command: built, baseArgs: [], display: built };
  }
  // cwd is the repo root, so cargo reads that workspace's `.cargo/config`, not the target
  // project's.
  return { command: "cargo", baseArgs: cargoArgs, cwd: repo, display: cargoDisplay };
}

export function resolveCli(projectDir?: string): DayCli {
  const cfg = vscode.workspace.getConfiguration("day");
  const cliPath = (cfg.get<string>("cliPath") ?? "day").trim();

  if (cliPath && cliPath !== "day") {
    return { command: cliPath, baseArgs: [], display: cliPath };
  }

  const repo = findDayRepoRoot(projectDir);
  if (repo) {
    return checkoutCli(repo, ["run", "-q", "-p", "day-cli", "--"], "cargo run -q -p day-cli --");
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
}

function projectArgs(projectRoot: string): string[] {
  // Omit --project when unknown so the CLI falls back to cwd-based Day.toml discovery.
  return projectRoot && projectRoot.length > 0 ? ["--project", projectRoot] : [];
}

/** Args for `day launch` (a single target). */
export function launchArgs(o: LaunchOptions): string[] {
  const args = [...projectArgs(o.projectRoot), "launch", "-p", o.target, "--profile", o.profile];
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
  return args;
}

/** Args for `day build` (a single target). */
export function buildArgs(projectRoot: string, target: string, profile: "debug" | "release"): string[] {
  return [...projectArgs(projectRoot), "build", "-p", target, "--profile", profile];
}

/** A shell-safe rendering of a command for display in a terminal/log line. */
export function renderCommand(cli: DayCli, args: string[]): string {
  const all = [cli.command, ...cli.baseArgs, ...args];
  return all.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
