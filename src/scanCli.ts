import * as cp from "child_process";
import { promisify } from "util";
import type { DayCli } from "./cli";

const execFile = promisify(cp.execFile);

/** A scan checks each source CLI once, then runs metadata directly against that build.
 * Keep this cache scoped to a scan so the next refresh still picks up source edits. */
export function scanCli(): (cli: DayCli) => Promise<DayCli> {
  const builds = new Map<string, Promise<DayCli>>();
  return cli => {
    if (cli.command !== "cargo" || cli.baseArgs[0] !== "run" || cli.baseArgs.at(-1) !== "--") {
      return Promise.resolve(cli);
    }
    const key = JSON.stringify([cli.command, cli.cwd, cli.baseArgs]);
    let build = builds.get(key);
    if (!build) {
      build = (async () => {
        const args = ["build", ...cli.baseArgs.slice(1, -1), "--message-format=json-render-diagnostics"];
        const { stdout } = await execFile(cli.command, args, {
          cwd: cli.cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
        });
        // Cargo is the authority for the executable path, including custom target directories
        // and configured target triples. Fresh artifacts are reported on no-op builds too.
        for (const line of stdout.trim().split("\n")) {
          const artifact = JSON.parse(line);
          if (artifact.reason === "compiler-artifact" && artifact.target?.name === "day" && artifact.executable) {
            return { command: artifact.executable, baseArgs: [], cwd: cli.cwd, display: artifact.executable };
          }
        }
        throw new Error("cargo build: missing compiler-artifact executable for day");
      })();
      builds.set(key, build);
    }
    return build;
  };
}
