// What each mobile target can be launched onto, from `day devices list --json`.
//
// The CLI owns every native tool this touches — simctl, devicectl, adb, hdc — and reports them
// through one versioned, grow-only envelope, so this module parses rather than probes. In
// particular each device carries the FLAG that selects it, because iOS needs a different one for a
// booted simulator than for a plugged-in phone; deriving that here would put the same knowledge in
// two places and guarantee they drift.
//
// Listing is neither free nor free of side effects — enumerating Android starts an adb server
// daemon — so nothing here runs on activation. The cache is filled the first time a device row or
// picker asks, and dropped when a run starts or stops or the user refreshes: a stale list is worse
// than a slow one when it names a phone that has since been unplugged.

import * as cp from "child_process";
import * as vscode from "vscode";

import { renderCommand, resolveCli } from "./cli";

/** One device the CLI reported. Read leniently — the envelope is grow-only. */
export interface Device {
  id: string;
  name: string;
  /** `simulator` | `device` | `emulator`, as the CLI classified it. */
  kind?: string;
  /** `booted` | `connected`, or adb's own word for a device that is not ready. */
  state?: string;
  runtime?: string;
  arch?: string;
  /** The `day launch` flag that selects this device. */
  flag?: string;
}

/** One target's enumeration. */
export interface TargetDevices {
  target: string;
  kind?: string;
  available: boolean;
  /** Why nothing can be listed, when `available` is false. */
  note?: string;
  devices: Device[];
  /** Simulators and AVDs that exist but are not running. */
  bootable: Device[];
}

interface Envelope {
  schema?: number;
  targets?: TargetDevices[];
}

/** How long a listing stays good before the next ask re-runs the CLI. */
const TTL_MS = 30_000;

let cache: { at: number; byTarget: Map<string, TargetDevices> } | undefined;
let inFlight: Promise<Map<string, TargetDevices>> | undefined;

/** Drop the cache — a launch, a stop, or an explicit Refresh can each change what is attached. */
export function invalidate(): void {
  cache = undefined;
}

/**
 * Every mobile target's devices, cached.
 *
 * One call covers all three targets because that is what the CLI answers in one process; asking
 * per target would triple the adb and simctl work for the same information.
 */
export async function list(
  projectRoot: string | undefined,
  output?: vscode.OutputChannel,
): Promise<Map<string, TargetDevices>> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.byTarget;
  }
  // Coalesced: expanding two mobile rows at once must not run two enumerations.
  inFlight ??= run(projectRoot, output).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** The cached listing if there is one, without running anything — for synchronous tree rendering. */
export function cached(): Map<string, TargetDevices> | undefined {
  return cache && Date.now() - cache.at < TTL_MS ? cache.byTarget : undefined;
}

function run(
  projectRoot: string | undefined,
  output?: vscode.OutputChannel,
): Promise<Map<string, TargetDevices>> {
  const cli = resolveCli(projectRoot);
  const args = [...cli.baseArgs, "--format", "json", "devices", "list"];
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      args,
      { cwd: cli.cwd ?? projectRoot, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const byTarget = new Map<string, TargetDevices>();
        if (err) {
          // Reported, never thrown: a missing CLI or an old one without `day devices` must leave
          // the sidebar usable, just without device rows.
          output?.appendLine(
            `✗ ${renderCommand(cli, args.slice(cli.baseArgs.length))}: ${stderr.trim() || err.message}`,
          );
          resolve(byTarget);
          return;
        }
        try {
          const doc = JSON.parse(stdout) as Envelope;
          for (const t of doc.targets ?? []) {
            byTarget.set(t.target, {
              ...t,
              devices: t.devices ?? [],
              bootable: t.bootable ?? [],
            });
          }
        } catch (e) {
          output?.appendLine(`✗ could not parse \`day devices list --json\`: ${e}`);
        }
        cache = { at: Date.now(), byTarget };
        resolve(byTarget);
      },
    );
  });
}

/**
 * Start a simulator, emulator or AVD through `day devices boot`, and report what went wrong if it
 * did not start. Resolves once the CLI returns — booting is not instant, so callers re-list after.
 */
export function boot(
  projectRoot: string | undefined,
  target: string,
  id: string,
): Promise<string | undefined> {
  const cli = resolveCli(projectRoot);
  const args = [...cli.baseArgs, "devices", "boot", "-p", target, id];
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      args,
      { cwd: cli.cwd ?? projectRoot, timeout: 120_000 },
      (err, _stdout, stderr) => {
        invalidate();
        resolve(err ? stderr.trim() || err.message : undefined);
      },
    );
  });
}

/** Whether a target has devices to choose between at all — desktop and web do not. */
export function isMobile(kind: string | undefined): boolean {
  return kind === "iosSim" || kind === "android" || kind === "harmonyOs";
}
