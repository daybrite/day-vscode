// What a mobile target can be launched onto, from `day devices list -p <target> --json`.
//
// The CLI owns every native tool this touches — simctl, devicectl, adb, hdc — and reports them
// through one versioned, grow-only envelope, so this module parses rather than probes. In
// particular each device carries the FLAG that selects it, because iOS needs a different one for a
// booted simulator than for a plugged-in phone; deriving that here would put the same knowledge in
// two places and guarantee they drift.
//
// Everything is per TARGET, never "all mobile targets at once". Asking for one costs only that
// one's tool — 0.13s for adb against 1.3s for the full sweep — but the reason is more than speed:
// opening the iOS picker has no business running `adb`, which starts a server daemon that outlives
// the command. You get what you asked about and nothing else.
//
// Nothing here runs on activation. A target's listing is fetched the first time its row or picker
// asks, and dropped when a run starts or stops or the user refreshes: a stale list is worse than a
// slow one when it names a phone that has since been unplugged.

import * as cp from "child_process";
import * as vscode from "vscode";

import { renderCommand, resolveCli } from "./cli";
import { toolchainEnv } from "./tasks";

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

const cache = new Map<string, { at: number; data: TargetDevices }>();
const inFlight = new Map<string, Promise<TargetDevices | undefined>>();

/** Drop what is known about one target, or about all of them. */
export function invalidate(target?: string): void {
  if (target) {
    cache.delete(target);
  } else {
    cache.clear();
  }
}

/** Whether THIS target is being enumerated right now — a row spins only for its own query. */
export function loading(target: string): boolean {
  return inFlight.has(target);
}

/** One target's listing if it is known and fresh, without running anything — for the tree, which
 *  renders synchronously and cannot wait on adb. */
export function cached(target: string): TargetDevices | undefined {
  const hit = cache.get(target);
  return hit && Date.now() - hit.at < TTL_MS ? hit.data : undefined;
}

/**
 * One target's devices, cached and coalesced.
 *
 * Coalesced per target so a row drawing and a picker opening at the same moment share one process
 * rather than racing two.
 */
export function list(
  projectRoot: string | undefined,
  output: vscode.OutputChannel | undefined,
  target: string,
): Promise<TargetDevices | undefined> {
  const fresh = cached(target);
  if (fresh) {
    return Promise.resolve(fresh);
  }
  const running = inFlight.get(target);
  if (running) {
    return running;
  }
  const started = run(projectRoot, output, target).finally(() => inFlight.delete(target));
  inFlight.set(target, started);
  return started;
}

function run(
  projectRoot: string | undefined,
  output: vscode.OutputChannel | undefined,
  target: string,
): Promise<TargetDevices | undefined> {
  const cli = resolveCli(projectRoot);
  const args = [...cli.baseArgs, "--format", "json", "devices", "list", "-p", target];
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      args,
      {
        cwd: cli.cwd ?? projectRoot,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        // adb, the emulator and xcrun are exactly what this command shells out to, so it needs
        // the same toolchain locations a build gets.
        env: { ...process.env, ...toolchainEnv() },
      },
      (err, stdout, stderr) => {
        if (err) {
          // Reported, never thrown: a missing CLI, or one too old to have `day devices`, must
          // leave the sidebar usable — just without device rows.
          output?.appendLine(
            `✗ ${renderCommand(cli, args.slice(cli.baseArgs.length))}: ${stderr.trim() || err.message}`,
          );
          resolve(undefined);
          return;
        }
        try {
          const doc = JSON.parse(stdout) as Envelope;
          const found = (doc.targets ?? []).find((t) => t.target === target);
          if (found) {
            const data: TargetDevices = {
              ...found,
              devices: found.devices ?? [],
              bootable: found.bootable ?? [],
            };
            cache.set(target, { at: Date.now(), data });
            resolve(data);
            return;
          }
        } catch (e) {
          output?.appendLine(`✗ could not parse \`day devices list --json\`: ${e}`);
        }
        resolve(undefined);
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
      { cwd: cli.cwd ?? projectRoot, timeout: 120_000, env: { ...process.env, ...toolchainEnv() } },
      (err, _stdout, stderr) => {
        invalidate(target);
        resolve(err ? stderr.trim() || err.message : undefined);
      },
    );
  });
}

/** Whether a target has devices to choose between at all — desktop and web do not. */
export function isMobile(kind: string | undefined): boolean {
  return kind === "iosSim" || kind === "android" || kind === "harmonyOs";
}
