// Build the workspace's Day projects against the crate checkouts the workspace already holds.
//
// A window that has both an app and a checkout of something the app depends on — `day` itself, or
// an external piece or part repository — almost always means the two are being worked on together.
// Cargo does not infer that: without a `[patch]` table the app fetches the published git revision
// and the edit under test never reaches it, silently, with everything looking right. `day patch
// --local <checkout>` writes that table, and this module decides when to offer it.
//
// What counts as "the app depends on this checkout" is the CLI's question, and the answer here is
// derived the same way it derives it (crates/day-cli/src/patch.rs): a checkout stands for one git
// URL, and a project depends on it when its resolved graph or its manifests name that URL. The
// alternative — handing every checkout to `day patch` and seeing what sticks — writes a patch
// table as a side effect of asking, which is not something to do behind a prompt that has not been
// answered yet.

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { patchArgs, renderCommand, resolveCli } from "./cli";
import { DayProject } from "./project";

/** The URL apps name the framework by. It is not written in day's own manifest, so it is spelled
 *  here exactly as `DAY_GIT` in crates/day-cli/src/patch.rs spells it. */
const DAY_GIT = "https://github.com/daybrite/day.git";

/** Remembers, per workspace, which offer was waved off — so "Not now" means not now, rather than
 *  once per window for the life of the checkout. Keyed by the offer's content, so adding another
 *  checkout later asks again. */
const DISMISSED = "day.localCheckouts.dismissed";

/** A folder in this workspace that a project could be built against. */
export interface LocalCheckout {
  /** Absolute path of the checkout. */
  dir: string;
  /** Its folder name, for messages. */
  name: string;
  /** The git URL it stands for, canonicalized — how a dependent project names it. */
  url: string;
}

/** One project and the checkouts it depends on but is not yet built against. */
export interface PatchPlan {
  project: DayProject;
  checkouts: LocalCheckout[];
}

/** `canon` from patch.rs: the comparable form of a git URL, so `…/day.git`, `…/day` and the
 *  `git+…?branch=x#sha` a lockfile writes are one URL. */
function canon(url: string): string {
  const bare = url.trim().replace(/^git\+/, "").split(/[?#]/)[0].replace(/\/+$/, "");
  return bare.replace(/\.git$/, "").toLowerCase();
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** One top-level string key from one of `tables`, without a TOML parser: the extension parses no
 *  manifests for meaning (project.ts explains why), and this is not meaning — it is the one field
 *  that says which URL a checkout answers to. Table-aware so a `repository` under some unrelated
 *  section cannot be mistaken for the package's own. */
function tomlString(text: string, tables: string[], key: string): string | undefined {
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      continue;
    }
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (!tables.includes(current)) {
      continue;
    }
    const hit = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (hit) {
      return hit[1];
    }
  }
  return undefined;
}

/** The git URL a checkout stands for, or undefined when it cannot say. Mirrors `checkout_url`:
 *  the day repository is known by the canonical URL, and every other checkout declares its own
 *  through `repository` in `[package]` or `[workspace.package]` — which is exactly the field
 *  `day patch` refuses to run without. */
function checkoutUrl(dir: string): string | undefined {
  if (fs.existsSync(path.join(dir, "crates", "day", "Cargo.toml"))) {
    return canon(DAY_GIT);
  }
  const repo = tomlString(read(path.join(dir, "Cargo.toml")), ["package", "workspace.package"], "repository");
  return repo ? canon(repo) : undefined;
}

/** The folders in this workspace that could be patch sources: a cargo checkout that is not itself
 *  one of the Day projects, and that says which URL it stands for. */
export function workspaceCheckouts(projects: DayProject[]): LocalCheckout[] {
  const roots = new Set(projects.map((p) => p.root));
  const found: LocalCheckout[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = folder.uri.fsPath;
    if (roots.has(dir) || !fs.existsSync(path.join(dir, "Cargo.toml"))) {
      continue;
    }
    const url = checkoutUrl(dir);
    if (url) {
      found.push({ dir, name: path.basename(dir), url });
    }
  }
  return found;
}

/** Every git URL this project resolves a dependency from. The lock is the honest answer — it is
 *  the graph cargo will actually build — and the manifests are the floor under it, for a project
 *  that has never been built and has no lock yet. */
async function gitSources(root: string): Promise<Set<string>> {
  const urls = new Set<string>();
  for (const m of read(path.join(root, "Cargo.lock")).matchAll(/^\s*source\s*=\s*"git\+([^"]+)"/gm)) {
    urls.add(canon(m[1]));
  }
  // Members too, not just the root manifest: an app whose games live in `games/*` names its
  // dependencies there, and the root is only a workspace table.
  const manifests = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/Cargo.toml"),
    "**/{target,build,node_modules}/**",
    64,
  );
  for (const uri of manifests) {
    for (const m of read(uri.fsPath).matchAll(/\bgit\s*=\s*"([^"]+)"/g)) {
      urls.add(canon(m[1]));
    }
  }
  return urls;
}

/** Is this project already built against this checkout? `day patch` writes the table into the
 *  project's gitignored `.cargo/config.toml` with absolute paths, so the checkout's own path
 *  appearing there is the whole test — and it distinguishes THIS checkout from another clone of
 *  the same repository, which a URL alone would not. */
function alreadyPatched(root: string, checkout: LocalCheckout): boolean {
  return read(path.join(root, ".cargo", "config.toml")).includes(checkout.dir);
}

/** What each project could be built against but is not. Projects with nothing to do are left out,
 *  so an empty result means there is nothing to offer. */
export async function planPatches(
  projects: DayProject[],
  checkouts: LocalCheckout[],
): Promise<PatchPlan[]> {
  const plans: PatchPlan[] = [];
  for (const project of projects) {
    const candidates = checkouts.filter((c) => !alreadyPatched(project.root, c));
    if (candidates.length === 0) {
      continue;
    }
    const sources = await gitSources(project.root);
    const wanted = candidates.filter((c) => sources.has(c.url));
    if (wanted.length > 0) {
      plans.push({ project, checkouts: wanted });
    }
  }
  return plans;
}

/** Run `day patch --local <checkout>…` for each plan. Every checkout a project depends on goes in
 *  one invocation: the table is rewritten whole, so patching them one at a time would leave each
 *  run undoing the last. */
export async function applyPatches(plans: PatchPlan[], output: vscode.OutputChannel): Promise<void> {
  for (const plan of plans) {
    const root = plan.project.root;
    const cli = resolveCli(root);
    const dayArgs = patchArgs(root, plan.checkouts.map((c) => c.dir));
    output.appendLine(`[local] ${renderCommand(cli, dayArgs)}`);
    const failure = await new Promise<string | undefined>((resolve) => {
      childProcess.execFile(
        cli.command,
        [...cli.baseArgs, ...dayArgs],
        { cwd: cli.cwd ?? root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const said = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
          if (said) {
            output.appendLine(said);
          }
          resolve(err ? stderr.trim() || err.message : undefined);
        },
      );
    });
    if (failure) {
      // Named rather than summarised: `day patch` says which crate or checkout it objected to, and
      // that sentence is the whole of what the reader needs.
      void vscode.window.showErrorMessage(
        `Day: could not build ${plan.project.name} against ${plan.checkouts
          .map((c) => c.name)
          .join(", ")} — ${failure}`,
        "Show Log",
      ).then((choice) => {
        if (choice === "Show Log") {
          output.show(true);
        }
      });
    } else {
      output.appendLine(
        `[local] ${plan.project.name} now builds against ${plan.checkouts.map((c) => c.name).join(", ")}`,
      );
    }
  }
}

/** A stable name for one offer, so a dismissal covers exactly the offer that was dismissed. */
function offerKey(plans: PatchPlan[]): string {
  return plans
    .map((p) => `${p.project.root}→${p.checkouts.map((c) => c.dir).sort().join(",")}`)
    .sort()
    .join("|");
}

/**
 * Offer — or, under `day.localCheckouts: always`, simply do — what this workspace makes possible.
 *
 * Called on activation, when a folder is added to the workspace, and from the command. It is
 * cheap when there is nothing to do (a few file reads), and silent: the point of the prompt is
 * that a window holding two repositories is not proof that someone wants one built against the
 * other, and rewriting a project's cargo resolution unasked would be a surprising thing to find.
 *
 * `manual` is the command's path: it reports the nothing-to-do cases out loud, which a startup
 * check must not, and it ignores an earlier dismissal, since asking for it again IS the answer.
 */
export async function offerLocalCheckouts(
  projects: DayProject[],
  output: vscode.OutputChannel,
  memento: vscode.Memento,
  manual = false,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("day");
  const mode = cfg.get<string>("localCheckouts", "prompt");
  if (mode === "never" && !manual) {
    return;
  }
  const checkouts = workspaceCheckouts(projects);
  const plans = await planPatches(projects, checkouts);
  if (plans.length === 0) {
    if (manual) {
      void vscode.window.showInformationMessage(
        checkouts.length === 0
          ? "Day: this workspace holds no crate checkout to build against — add one as a folder."
          : `Day: nothing to change — ${checkouts.map((c) => c.name).join(", ")} ${
              checkouts.length > 1 ? "are" : "is"
            } already what the projects here build against.`,
      );
    }
    return;
  }

  const names = [...new Set(plans.flatMap((p) => p.checkouts.map((c) => c.name)))];
  const subjects = plans.map((p) => p.project.name);
  if (mode === "always" && !manual) {
    output.appendLine(
      `[local] day.localCheckouts is "always" — building ${subjects.join(", ")} against ${names.join(", ")}`,
    );
    await applyPatches(plans, output);
    return;
  }

  const key = offerKey(plans);
  if (!manual && memento.get<string[]>(DISMISSED, []).includes(key)) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Day: this workspace has ${names.join(", ")} open beside ${subjects.join(", ")}. Build against ${
      names.length > 1 ? "them" : "it"
    } instead of the published version?`,
    "Build Against Them",
    "Not Now",
    "Never",
  );
  if (choice === "Build Against Them") {
    await applyPatches(plans, output);
  } else if (choice === "Not Now") {
    await memento.update(DISMISSED, [...memento.get<string[]>(DISMISSED, []), key]);
  } else if (choice === "Never") {
    // Global, not workspace: "never" is a preference about how the extension behaves, and someone
    // who says it here means it for the next window too.
    await cfg.update("localCheckouts", "never", vscode.ConfigurationTarget.Global);
  }
}
