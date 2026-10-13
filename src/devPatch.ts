// The dev launcher selects sources without using a mutating `day patch` as a probe.
// The CLI still owns table generation, relocking, and cross-platform verification.
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { repository, manifestGitSources, lockGitSources } from "./cargoToml";

const execFile = promisify(cp.execFile);
const canon = (url: string): string => url.trim().replace(/^git\+/, "")
  .split(/[?#]/)[0].replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
const read = (file: string): string => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

export interface PatchCheckout { dir: string; url: string }
interface CargoPackage { source?: string | null; manifest_path?: string }

export function patchCheckouts(day: string, folders: string[]): PatchCheckout[] {
  const seen = new Set([fs.realpathSync(day)]);
  return folders.flatMap(folder => {
    const dir = fs.realpathSync(folder);
    if (seen.has(dir)) { return []; }
    seen.add(dir);
    const url = repository(read(path.join(dir, "Cargo.toml")));
    return url ? [{ dir, url: canon(url) }] : [];
  });
}

function within(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Metadata without a platform filter includes dependencies for all target platforms. */
export function matchingCheckouts(
  root: string, checkouts: PatchCheckout[], packages: CargoPackage[], fallbackSources: string[],
): PatchCheckout[] {
  const sources = new Set(fallbackSources.map(canon));
  for (const pkg of packages) {
    if (pkg.manifest_path && within(pkg.manifest_path, root)) { continue; }
    if (pkg.source?.startsWith("git+")) {
      sources.add(canon(pkg.source));
    } else if (!pkg.source && pkg.manifest_path) {
      const checkout = checkouts.find(c => within(pkg.manifest_path!, c.dir));
      if (checkout) { sources.add(checkout.url); }
    }
  }
  return checkouts.filter(c => sources.has(c.url));
}

export async function patchProject(binary: string, day: string, root: string, checkouts: PatchCheckout[]): Promise<void> {
  let selected: PatchCheckout[] = [];
  if (checkouts.length) {
    const manifestSources = manifestGitSources(read(path.join(root, "Cargo.toml")));
    try {
      // One read of the graph, instead of seven resolutions per project/folder probe.
      const { stdout } = await execFile("cargo", ["metadata", "--format-version", "1", "--all-features"], {
        cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      });
      selected = matchingCheckouts(root, checkouts, JSON.parse(stdout).packages, manifestSources);
    } catch {
      // As in day patch, manifest entries are the floor when Cargo cannot resolve yet.
      selected = matchingCheckouts(root, checkouts, [], [
        ...manifestSources, ...lockGitSources(read(path.join(root, "Cargo.lock"))),
      ]);
    }
  }
  for (;;) {
    const args = ["patch", "--local", day, ...selected.flatMap(c => ["--local", c.dir]), "--project", root];
    const result = cp.spawnSync(binary, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // A stale lock or an optional dependency can name a source the CLI doesn't use.
    // Its rejection happens before writing; remove only that source and retry.
    const unused = output.match(/no dependencies from (\S+) — nothing to patch/);
    // Missing crates are also rejected while constructing the table, before any write.
    // Preserve the launcher's warning-and-skip behavior for optional checkouts without
    // probing every source. The required day checkout and verification failures stay fatal.
    const missing = selected.find(c => output.includes(
      ` is not in the checkout at ${c.dir} — is it the right checkout, or the wrong branch?`,
    ));
    const rejected = missing ?? (unused && selected.find(c => c.url === canon(unused[1])));
    if (!result.error && result.status !== null && result.status !== 0 && rejected) {
      if (missing) {
        console.error(`  ! ${path.basename(missing.dir)} could not be patched in, and is not in the table:`);
        process.stderr.write(output);
      }
      selected = selected.filter(c => c !== rejected);
      continue;
    }
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) { throw result.error; }
    if (result.status !== 0) { throw new Error(`${binary} patch: ${result.status ?? result.signal}`); }
    return;
  }
}

if (require.main === module) {
  const [binary, day, count, ...dirs] = process.argv.slice(2);
  const projects = dirs.slice(0, Number(count));
  const checkouts = patchCheckouts(day, dirs.slice(Number(count)));
  (async () => {
    for (const root of projects) {
      console.log(`▸ pointing ${path.basename(root)} at ${day}…`);
      await patchProject(binary, day, root, checkouts);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
