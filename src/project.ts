// Discover Day projects (folders with a `Day.toml` manifest) and load each one's metadata by
// shelling out to `day metadata --json`. The CLI owns the manifest format AND the target
// catalog, so the extension never parses Day.toml itself — the JSON envelope is versioned and
// grow-only (see crates/day-cli/src/metadata.rs), which is what lets the manifest evolve
// without breaking editors. Day.toml's presence is still used to LOCATE projects (it is the
// project marker); everything read out of it comes from the CLI.

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { renderCommand, resolveCli } from "./cli";
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

/** A Day.toml we located but couldn't load — the `day` CLI failed to return metadata for it.
 *  Surfaced to the user (see extension.ts) so this doesn't masquerade as "no project found". */
export interface ProjectLoadFailure {
  /** Directory that held the Day.toml. */
  root: string;
  /** Human-readable rendering of the CLI invocation we attempted. */
  command: string;
  /** Why it failed — the CLI's stderr/message, or a not-found hint. */
  message: string;
  /** The CLI executable itself wasn't found (ENOENT) — the usual "no `day` on PATH" case. */
  notFound: boolean;
}

/** Result of scanning the workspace: the projects that loaded, plus any that failed to. */
export interface ProjectScan {
  projects: DayProject[];
  failures: ProjectLoadFailure[];
}

export async function findProjects(): Promise<ProjectScan> {
  const uris = await vscode.workspace.findFiles(
    "**/Day.toml",
    "**/{node_modules,target,build,out}/**",
    100,
  );
  const projects: DayProject[] = [];
  const failures: ProjectLoadFailure[] = [];
  for (const uri of uris) {
    const { project, failure } = await loadProject(path.dirname(uri.fsPath));
    if (project) {
      projects.push(project);
    } else if (failure) {
      failures.push(failure);
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  return { projects, failures };
}

/** Load one project's metadata through the CLI. Also feeds the CLI's target catalog to
 *  `targets.setCatalog`, so the sidebar reflects the installed CLI's target table rather than
 *  this extension's baked-in fallback mirror. Returns a `failure` when the CLI couldn't be run
 *  (or errored); returns neither when the CLI ran fine but the Day.toml is not an app project. */
export async function loadProject(
  root: string,
): Promise<{ project?: DayProject; failure?: ProjectLoadFailure }> {
  const meta = await dayMetadata(root);
  if (!meta.ok) {
    return { failure: { root, command: meta.command, message: meta.message, notFound: meta.notFound } };
  }
  const p = meta.envelope?.project;
  if (!p || p.id === undefined) {
    return {};
  }
  setCatalog(meta.envelope?.targetCatalog);
  return {
    project: {
      root: p.root ?? root,
      name: p.name ?? path.basename(root),
      version: p.version,
      id: p.id,
      title: p.title,
      targets: p.targets ?? [],
    },
  };
}

/** Outcome of one `day metadata` call: the parsed envelope on success, else why it failed. */
type MetadataResult =
  | { ok: true; envelope: MetadataEnvelope | undefined }
  | { ok: false; command: string; message: string; notFound: boolean };

function dayMetadata(root: string): Promise<MetadataResult> {
  const cli = resolveCli(root);
  const command = renderCommand(cli, ["metadata", "--json", "--project", root]);
  const args = [...cli.baseArgs, "metadata", "--json", "--project", root];
  return new Promise((resolve) => {
    cp.execFile(cli.command, args, { cwd: cli.cwd ?? root, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        const message = notFound ? `the \`${cli.command}\` CLI was not found` : stderr.trim() || err.message;
        console.warn(`day metadata failed for ${root} (${command}): ${message}`);
        resolve({ ok: false, command, message, notFound });
        return;
      }
      try {
        resolve({ ok: true, envelope: JSON.parse(stdout) as MetadataEnvelope });
      } catch (e) {
        resolve({ ok: false, command, message: `unparseable metadata output: ${e}`, notFound: false });
      }
    });
  });
}
