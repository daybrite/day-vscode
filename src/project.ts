// Discover Day projects (folders with a `Day.toml` manifest) and load each one's metadata by
// shelling out to `day metadata --json`. The CLI owns the manifest format AND the target
// catalog, so the extension never parses Day.toml itself — the JSON envelope is versioned and
// grow-only (see crates/day-cli/src/metadata.rs), which is what lets the manifest evolve
// without breaking editors. Day.toml's presence is still used to LOCATE projects (it is the
// project marker); everything read out of it comes from the CLI.

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { resolveCli } from "./cli";
import { setCatalog, Target } from "./targets";

export interface DayProject {
  /** Directory containing Day.toml. */
  root: string;
  name: string;
  version?: string;
  id: string;
  title?: string;
  /** Targets declared in Day.toml's `[app] targets` (may be empty). */
  targets: string[];
}

/** The `day metadata --json` envelope (schema 1) — read leniently: absent keys are tolerated
 *  so newer CLIs can add fields freely. */
interface MetadataEnvelope {
  schema?: number;
  project?: {
    root?: string;
    name?: string;
    version?: string;
    id?: string;
    title?: string;
    targets?: string[];
  };
  targetCatalog?: Target[];
}

export async function findProjects(): Promise<DayProject[]> {
  const uris = await vscode.workspace.findFiles(
    "**/Day.toml",
    "**/{node_modules,target,build,out}/**",
    100,
  );
  const projects: DayProject[] = [];
  for (const uri of uris) {
    const p = await loadProject(path.dirname(uri.fsPath));
    if (p) {
      projects.push(p);
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  return projects;
}

/** Load one project's metadata through the CLI. Also feeds the CLI's target catalog to
 *  `targets.setCatalog`, so the sidebar reflects the installed CLI's target table rather than
 *  this extension's baked-in fallback mirror. */
export async function loadProject(root: string): Promise<DayProject | undefined> {
  const doc = await dayMetadata(root);
  const p = doc?.project;
  if (!p || p.id === undefined) {
    return undefined;
  }
  setCatalog(doc?.targetCatalog);
  return {
    root: p.root ?? root,
    name: p.name ?? path.basename(root),
    version: p.version,
    id: p.id,
    title: p.title,
    targets: p.targets ?? [],
  };
}

function dayMetadata(root: string): Promise<MetadataEnvelope | undefined> {
  const cli = resolveCli(root);
  const args = [...cli.baseArgs, "metadata", "--json", "--project", root];
  return new Promise((resolve) => {
    cp.execFile(cli.command, args, { cwd: cli.cwd ?? root, timeout: 30000 }, (err, stdout) => {
      if (err) {
        console.warn(`day metadata failed for ${root}:`, err.message);
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as MetadataEnvelope);
      } catch (e) {
        console.warn(`day metadata: unparseable output for ${root}:`, e);
        resolve(undefined);
      }
    });
  });
}
