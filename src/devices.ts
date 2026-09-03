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
  /** For an Android emulator, the AVD it is running — the name `day devices boot` starts it by. */
  avd?: string;
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
 * did not start.
 *
 * `wait` blocks until the device has finished booting rather than until the boot has been asked
 * for. What a row's Start wants: the answer decides what the row says next, and an Android
 * emulator is not in `adb devices` for a while after the command returns — so without it the row
 * that was just started reads `not found`.
 */
export function boot(
  projectRoot: string | undefined,
  target: string,
  id: string,
  wait = false,
): Promise<string | undefined> {
  const cli = resolveCli(projectRoot);
  const args = [...cli.baseArgs, "devices", "boot", "-p", target, id];
  if (wait) {
    args.push("--wait");
  }
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      args,
      {
        cwd: cli.cwd ?? projectRoot,
        // Waiting means waiting for the DEVICE, and an Android emulator's cold boot is minutes,
        // not seconds — the CLI gives up at ten and says why. Cutting it short here would kill
        // the report without stopping the emulator, which stays detached either way.
        timeout: wait ? 15 * 60_000 : 120_000,
        env: { ...process.env, ...toolchainEnv() },
      },
      (err, _stdout, stderr) => {
        invalidate(target);
        resolve(err ? stderr.trim() || err.message : undefined);
      },
    );
  });
}

/**
 * A configured device's standing as something this extension can start and stop.
 *
 * `noun` is the word the menu uses, and it comes from the TARGET rather than from the device:
 * "simulator" on iOS, "emulator" on Android. The distinction is the user's own — a row offering to
 * "Start Emulator" for an iPhone would be naming the wrong thing.
 */
export interface VirtualDevice {
  /** Running right now, so it can be stopped. */
  running: boolean;
  /** The id to hand `day devices boot` / `day devices shutdown`. */
  id: string;
  noun: "simulator" | "emulator";
  /** The platform word that goes in front of `noun` in a sentence about this device. */
  platform: "iOS" | "Android";
}

/**
 * Whether one configured device is a simulator or emulator this extension can start and stop, and
 * under which id.
 *
 * `undefined` covers three different situations on purpose, all of which mean the same thing for a
 * menu — offer nothing:
 *
 *   * nothing has been enumerated for this target yet, or its toolchain is missing, so the answer
 *     is not known. Guessing "stopped" would put Start on a row that is running.
 *   * the device is a physical phone. There is no software to start, and unplugging it is the way
 *     to stop it.
 *   * it is neither running nor startable — a simulator that was deleted, or an emulator whose AVD
 *     is gone. The row already says `not found`.
 *   * it belongs to `harmony-arkui`. The OpenHarmony emulator is started by `day ohos emulator
 *     launch` and has no stop, so both entries would name something the CLI cannot do. The moment
 *     `day devices shutdown` covers it, this list gains one kind.
 *
 * Android is why `avd` exists. Its running emulators are keyed by an adb SERIAL, which is a
 * console port rather than an identity: once one stops, its serial names nothing at all, and only
 * the AVD ties the row back to something `day devices boot` can start.
 */
export function virtualDevice(
  listing: TargetDevices | undefined,
  choice: { id: string; avd?: string },
): VirtualDevice | undefined {
  if (!listing?.available || (listing.kind !== "iosSim" && listing.kind !== "android")) {
    return undefined;
  }
  const ios = listing.kind === "iosSim";
  const named = { noun: ios ? "simulator" : "emulator", platform: ios ? "iOS" : "Android" } as const;
  const live = listing.devices.find((d) => d.id === choice.id);
  if (live) {
    // A physical phone is the one live device with nothing to offer. `kind` is the CLI's own
    // classification, and an unrecognized one is left alone rather than assumed startable.
    return live.kind === "simulator" || live.kind === "emulator"
      ? { running: true, id: live.id, ...named }
      : undefined;
  }
  // Not running. Either the row's own id is something bootable (a simulator UDID, or an AVD picked
  // from the "Not running" list), or its AVD is.
  const startable = listing.bootable.find(
    (d) => d.id === choice.id || (choice.avd !== undefined && d.id === choice.avd),
  );
  return startable ? { running: false, id: startable.id, ...named } : undefined;
}

/**
 * What a device row's Play asks before it launches onto a simulator or emulator that is not up.
 *
 * A sentence rather than a question, with the choice carried by the buttons ("Launch It" /
 * "Cancel"): the device is NAMED, because a row shows a label and a project can hold several, and
 * agreeing to start the wrong iPad is the mistake this prompt exists to prevent.
 */
export function startPrompt(label: string, device: VirtualDevice): string {
  return `The "${label}" ${device.platform} ${device.noun} is not currently running.`;
}

/** Whether a target has devices to choose between at all — desktop and web do not. */
export function isMobile(kind: string | undefined): boolean {
  return kind === "iosSim" || kind === "android" || kind === "harmonyOs";
}

/**
 * Stop a running simulator or emulator through `day devices shutdown`, reporting what went wrong
 * if it is still up. Resolves once the CLI returns; the CLI waits for an emulator to actually go,
 * so a re-list after this describes the machine rather than one on its way out.
 */
export function shutdown(
  projectRoot: string | undefined,
  target: string,
  id: string,
): Promise<string | undefined> {
  const cli = resolveCli(projectRoot);
  const args = [...cli.baseArgs, "devices", "shutdown", "-p", target, id];
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
