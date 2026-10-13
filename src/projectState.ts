import * as fs from "fs";
import * as path from "path";
import type { DayProject, ProjectScan } from "./project";

function rootKey(root: string): string {
  let resolved = path.resolve(root);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* Deleted or synthetic root. */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** A failed metadata read is not evidence that a previously loaded project disappeared.
 * Keep its last successful metadata while the existing error reporting explains the failure.
 * A root no longer discovered (or successfully read as a non-app) is still removed. */
export function projectsAfterScan(previous: DayProject[], scan: ProjectScan): DayProject[] {
  const loaded = new Set(scan.projects.map(p => rootKey(p.root)));
  const failed = new Set(scan.failures.map(f => rootKey(f.root)));
  return [...scan.projects, ...previous.filter(p => {
    const key = rootKey(p.root);
    return failed.has(key) && !loaded.has(key);
  })].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}
