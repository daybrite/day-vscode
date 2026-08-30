// Getting the `day` CLI, so that having one is not a prerequisite for using this extension.
//
// Two kinds of route live here. The FIRST is a source build the extension owns: `cargo install
// --git` at the revision `day.cliVersion` names, into the extension's own global storage. That is
// what makes an installed CLI optional — nothing has to be on PATH, `resolveCli` finds it, and
// `day.cliVersion` decides which day-cli an app is built with. It also solves version skew the
// other way round: when this extension needs a CLI change that has not been released, `main` is a
// setting rather than a support thread.
//
// The REST are the day release's own installers (rendered per release by scripts/release/templates
// in the day repository), which put a prebuilt binary on PATH. They stay because a source build
// needs a Rust toolchain and takes minutes, and someone who just wants to read a Day project
// should not have to compile a compiler front-end first.
//
// Nothing here installs silently. Every route shows its command before running it, in a terminal
// the user can watch and interrupt. Running an install unattended, on activation, because a file
// called Day.toml happened to be in the folder, is not a decision an extension should make for
// someone. Running it on a button press, with the command visible first, is. The source route is
// the least invasive of them — it writes only inside this extension's storage, and deleting that
// folder undoes it — but it is still offered rather than assumed.

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { hasCargo, resolveCli } from "./cli";

/** The repository every source install builds from. */
export const DAY_REPO = "https://github.com/daybrite/day.git";

/**
 * Where the extension keeps a CLI it built itself.
 *
 * Inside the extension's own global storage rather than `~/.cargo/bin`, for three reasons: it
 * needs no PATH change, so it works in a window that inherited none of the user's shell; it does
 * not overwrite a `day` the user installed themselves, which stays authoritative on their PATH;
 * and it can be pinned to a version and replaced wholesale without touching anything else.
 * Deleting the folder undoes the whole thing.
 */
export function managedCliDir(globalStorage: string): string {
  return path.join(globalStorage, "cli");
}

/** The CLI this extension installed, if it did. */
export function managedCliBinary(globalStorage: string): string | undefined {
  const exe = process.platform === "win32" ? "day.exe" : "day";
  const binary = path.join(managedCliDir(globalStorage), "bin", exe);
  return fs.existsSync(binary) ? binary : undefined;
}

/** Which source revision to build, as git flags plus something to show a human. */
export interface SourceVersion {
  /** Git ref flags, e.g. `["--tag", "v0.3.0"]`. Empty for a crates.io release. */
  ref: string[];
  /** What to call this version in a message. */
  label: string;
  /** Whether it comes from the git repository rather than from crates.io. */
  fromGit: boolean;
}

const MAIN: SourceVersion = {
  ref: ["--branch", "main"],
  label: "main",
  fromGit: true,
};

/**
 * Read `day.cliVersion` into an install target.
 *
 * Empty — the default — is the newest RELEASE, taken from crates.io rather than from the git tags:
 * that is the same answer the CLI's own update check gives, so the version the Day view calls
 * "latest" and the version an install produces are one thing rather than two that can disagree.
 * `main` is the development branch, for when this extension needs a CLI change that has not been
 * released yet. Anything else is a git tag or revision, taken literally.
 */
export function resolveSourceVersion(setting: string): SourceVersion {
  const want = setting.trim();
  if (want === "main") {
    return MAIN;
  }
  if (want !== "") {
    return { ref: ["--tag", want], label: want, fromGit: true };
  }
  return { ref: [], label: "the newest release", fromGit: false };
}

/**
 * The command that installs the CLI, exactly as it will be typed.
 *
 * `--force` because switching versions means replacing what is already in that root, and cargo
 * refuses otherwise. `--locked` because a release's own `Cargo.lock` is what its CI built and
 * tested with, and resolving fresh is how an install of a pinned version stops matching it.
 */
export function sourceInstallCommand(
  version: SourceVersion,
  root: string,
): string {
  const quote = (s: string) => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  if (!version.fromGit) {
    // The published crate. No `--locked`: a released crate is resolved against the registry as
    // any dependency is, and pinning to whatever lock happened to be packaged is how an install
    // fails on a yanked transitive version months later.
    return `cargo install day-cli --force --root ${quote(root)}`;
  }
  // From the repository. `--force` because switching versions replaces what is in that root and
  // cargo refuses otherwise; `--locked` because a revision's own `Cargo.lock` is what its CI built
  // and tested with, and resolving fresh is how a pinned build stops matching it.
  return [
    "cargo install",
    "--git",
    DAY_REPO,
    ...version.ref,
    "--locked --force --root",
    quote(root),
    "day-cli",
  ].join(" ");
}

/** One way to get the CLI, with the command a user can read before running it. */
export interface InstallRoute {
  /** Short label for a quick pick. */
  label: string;
  /** What it does and what it needs. ONE SHORT LINE: a quick pick truncates the rest. */
  detail: string;
  /** The dimmed column beside the label — a name, not the command, which is long enough to be
   *  cut mid-flag and reads as noise when it is. The terminal shows the real thing. */
  description: string;
  /** The command, exactly as it would be typed. */
  command: string;
  /** Shell to run it in, when the platform's default is wrong for the command. */
  shell?: string;
}

const SH_INSTALLER =
  "curl --proto '=https' --tlsv1.2 -LsSf " +
  "https://github.com/daybrite/day/releases/latest/download/day-installer.sh | sh";

const PS_INSTALLER =
  'powershell -ExecutionPolicy Bypass -c "irm ' +
  'https://github.com/daybrite/day/releases/latest/download/day-installer.ps1 | iex"';

/**
 * The PATH routes for a platform, best first.
 *
 * The release installer comes first because it downloads a prebuilt binary: no Rust toolchain, no
 * compile. `cargo install` is last — it needs a toolchain, and someone who has not got the CLI
 * often has not got Rust either.
 */
export function installRoutes(
  platform: NodeJS.Platform = process.platform,
): InstallRoute[] {
  // Only the prebuilt installer. `cargo install day-cli` used to sit here too, but its one
  // distinction from the managed release row above it was landing on PATH — and this route does
  // that without a Rust toolchain and without a multi-minute compile, so it was strictly worse at
  // the only job that made it a separate choice.
  return platform === "win32"
    ? [
        {
          label: "Run the Windows installer",
          detail: "Prebuilt binary onto your PATH.",
          description: "day-installer.ps1",
          command: PS_INSTALLER,
        },
      ]
    : [
        {
          label: "Run the install script",
          detail: "Prebuilt binary onto your PATH.",
          description: "day-installer.sh",
          command: SH_INSTALLER,
        },
      ];
}

/** The docs page that explains all of this at length. */
export const DOCS_URL = "https://daybrite.dev/docs/getting-started/";

/** Where the CLI's own update check looks, so the extension and the CLI agree on "latest". */
const CRATES_URL = "https://crates.io/api/v1/crates/day-cli";

/** What the extension knows about the CLI it is driving. */
export interface CliVersions {
  /** The version `day version` reports, or `undefined` when no CLI could be run. */
  installed?: string;
  /** The newest stable release on crates.io, when it could be reached. */
  latest?: string;
}

/**
 * `1.2.3` as numbers, ignoring anything after the patch.
 *
 * A build from source reports `0.3.0*` (the `*` marks a debug profile) and a git build appends its
 * ref, so the string is parsed rather than compared: `"0.4.0" > "0.10.0"` is the lexicographic
 * answer, and it is wrong in exactly the case that matters.
 */
function parts(version: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `latest` is a newer release than `installed`. False when either cannot be read. */
export function isNewer(installed: string, latest: string): boolean {
  const [a, b] = [parts(installed), parts(latest)];
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) {
      return b[i] > a[i];
    }
  }
  return false;
}

/** The version out of `day version`'s line: `day 0.3.0 (release, branch main, abc1234)`. */
export function parseVersion(output: string): string | undefined {
  return /^day\s+(\S+)/m.exec(output.trim())?.[1];
}

/** Ask the resolved CLI what version it is. `undefined` when it cannot be run at all. */
export async function installedVersion(
  projectDir?: string,
): Promise<string | undefined> {
  const cli = resolveCli(projectDir);
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      [...cli.baseArgs, "version"],
      {
        cwd: cli.cwd,
        timeout: 60_000,
        env: { ...process.env, DAY_NO_UPDATE_CHECK: "1" },
      },
      (err, stdout) => resolve(err ? undefined : parseVersion(stdout)),
    );
  });
}

/** The newest stable day-cli on crates.io, or `undefined` if the network did not answer. */
export async function latestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(CRATES_URL, {
      headers: {
        "user-agent": "day-vscode (https://github.com/daybrite/day-vscode)",
      },
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as {
      crate?: { max_stable_version?: string };
    };
    return body.crate?.max_stable_version;
  } catch {
    return undefined;
  }
}

/**
 * Build the CLI from source into the extension's own storage, at the version `day.cliVersion` asks
 * for.
 *
 * This is what makes an installed `day` optional rather than a prerequisite. It is not silent and
 * not automatic: the command is shown, it runs in a terminal the user can watch and interrupt, and
 * it writes nowhere but this extension's storage.
 *
 * It does need a Rust toolchain — but so does every Day app, which is a Rust crate, so anyone who
 * can build what this extension exists to run already has one.
 */
export async function installFromSource(
  globalStorage: string,
  versionOverride?: string,
): Promise<void> {
  if (!hasCargo()) {
    const choice = await vscode.window.showErrorMessage(
      "Day: building the CLI from source needs a Rust toolchain, and `cargo` is not on the PATH this window inherited. Install Rust, or use a prebuilt binary instead.",
      "Get Rust",
      "Other install options",
    );
    if (choice === "Get Rust") {
      await vscode.env.openExternal(vscode.Uri.parse("https://rustup.rs"));
    } else if (choice === "Other install options") {
      await promptToInstall();
    }
    return;
  }

  // The picker names the version it means, so its choice wins over the setting; the setting is
  // what an unqualified install follows, and where a specific tag is pinned.
  const setting =
    versionOverride ??
    (vscode.workspace.getConfiguration("day").get<string>("cliVersion") ?? "").trim();

  const version = resolveSourceVersion(setting);

  const root = managedCliDir(globalStorage);
  const command = sourceInstallCommand(version, root);
  const confirmed = await vscode.window.showInformationMessage(
    `Build the day CLI from source at ${version.label}?`,
    {
      modal: true,
      detail: `${command}\n\nCompiling takes a few minutes. It installs only into this extension's storage, and leaves any \`day\` on your PATH alone.`,
    },
    "Build it",
  );
  if (confirmed !== "Build it") {
    return;
  }

  await fs.promises.mkdir(root, { recursive: true });
  const terminal = vscode.window.createTerminal({ name: "Install day CLI" });
  terminal.show(true);
  terminal.sendText(command, true);

  // Nothing here polls for the binary: a build is minutes long, and a watcher that fires on a
  // half-written file is worse than asking. The refresh is what picks it up.
  void vscode.window
    .showInformationMessage(
      "Building the day CLI in the terminal. Refresh the Day view when it finishes.",
      "Refresh",
    )
    .then((choice) => {
      if (choice === "Refresh") {
        void vscode.commands.executeCommand("day.refresh");
      }
    });
}

/** Context key the walkthrough's update step is gated on (`when`). */
export const UPDATE_CONTEXT = "day.cliUpdateAvailable";

/**
 * Read both versions, publish whether an update is available, and hand the pair back.
 *
 * The context key is the only channel a walkthrough has: its step text is a fixed string in
 * `package.json`, so it can be SHOWN conditionally but cannot say which version you have. The
 * numbers therefore travel to places that can render them — the install picker's title, and the
 * log.
 */
export async function checkVersions(
  projectDir: string | undefined,
  output?: vscode.OutputChannel,
): Promise<CliVersions> {
  const [installed, latest] = await Promise.all([
    installedVersion(projectDir),
    latestVersion(),
  ]);
  const stale = !!installed && !!latest && isNewer(installed, latest);
  void vscode.commands.executeCommand("setContext", UPDATE_CONTEXT, stale);
  output?.appendLine(
    `day CLI: installed ${installed ?? "not found"}, latest ${latest ?? "unknown"}` +
      (stale ? " — an update is available" : ""),
  );
  return { installed, latest };
}

/**
 * Offer the install routes, and run the chosen one in a terminal.
 *
 * A terminal rather than a hidden child process: the command is visible, its output is visible,
 * and anything it asks for (a sudo prompt, a password) can be answered. When it
 * finishes, the caller's refresh is what picks the CLI up.
 */
/** One row of the install picker. `version` marks the rows the extension installs itself. */
export interface InstallChoice {
  label: string;
  /** What the row installs. Keep it to 70 characters; the picker ellipsizes past that. */
  detail: string;
  /** The command, or a shortened form of it. Keep it to 50 characters, same reason. */
  description: string;
  /** A PATH route to run in a terminal, for the rows that are one. */
  route?: InstallRoute;
  /** A `day.cliVersion` value for the rows the extension installs into its own storage. */
  version?: string;
}

/**
 * The picker's rows, in the order they are offered.
 *
 * Order is the point, so it is a function rather than an array literal inside the `showQuickPick`
 * call: the released CLI first because it is what almost everyone wants and the extension owns
 * that copy, the PATH routes next, and the source build last because it needs a Rust toolchain
 * and takes minutes. `managed` is false when there is nowhere to put an extension-owned copy,
 * which drops those rows entirely rather than offering something that cannot run.
 */
export function installChoices(
  routes: InstallRoute[],
  managed: boolean,
  pinned?: string,
): InstallChoice[] {
  const out: InstallChoice[] = [];
  if (managed) {
    out.push({
      label: "Install the latest release (crates.io)",
      detail: "Managed by this extension, built from the latest crates.io release.",
      description: "cargo install day-cli",
      version: "",
    });
    // A pinned `day.cliVersion` is a deliberate choice, so it is offered rather than buried:
    // without this the picker could only ever install the release or the branch.
    if (pinned) {
      out.push({
        label: `Install ${pinned} (day.cliVersion)`,
        // A pinned version is a git tag, not a crates.io release: `resolveSourceVersion` turns
        // any non-empty, non-`main` setting into `--tag`, which the description below shows.
        detail: "Managed by this extension, built from that tag in the Day repository.",
        description: "cargo install --git … --tag",
        version: pinned,
      });
    }
  }
  for (const r of routes) {
    out.push({
      label: r.label,
      detail: r.detail,
      description: r.description,
      route: r,
    });
  }
  if (managed) {
    out.push({
      label: "Install from Source (main branch)",
      detail:
        "Build from source for the development branch on GitHub.",
      description: "cargo install --git … --branch main",
      version: "main",
    });
  }
  out.push({
    label: "Open the install instructions",
    detail: "Read the installation documentation on daybrite.dev.",
    description: DOCS_URL,
  });
  return out;
}

export async function promptToInstall(
  globalStorage?: string,
  versions?: CliVersions,
): Promise<void> {
  const routes = installRoutes();
  // A `day.cliVersion` that is neither the release nor the branch is a pin, and gets its own row.
  const setting = (
    vscode.workspace.getConfiguration("day").get<string>("cliVersion") ?? ""
  ).trim();
  const pinned = setting !== "" && setting !== "main" ? setting : undefined;
  const picked = await vscode.window.showQuickPick(
    installChoices(routes, !!globalStorage, pinned),
    {
      title: versions
        ? `Day CLI — installed ${versions.installed ?? "none"}, latest ${versions.latest ?? "unknown"}`
        : "Install or update the Day CLI",
      placeHolder: versions?.installed
        ? "Re-running a route replaces the CLI in place, which is how an update happens"
        : "The extension runs the `day` CLI; it is not installed yet",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  if (picked.version !== undefined && globalStorage) {
    await installFromSource(globalStorage, picked.version);
    return;
  }
  if (!picked.route) {
    await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
    return;
  }

  const terminal = vscode.window.createTerminal({ name: "Install day CLI" });
  terminal.show(true);
  terminal.sendText(picked.route.command, true);

  // The CLI lands on PATH, and a terminal VS Code already started does not see a PATH change —
  // so tell the user what to do next rather than leaving them to guess why the view is still
  // empty. `day.refresh` re-runs the scan for the common case where the shell picks it up.
  void vscode.window
    .showInformationMessage(
      "Installing the day CLI in the terminal. When it finishes, refresh the Day view — or reload the window if `day` still isn't found.",
      "Refresh",
      "Reload Window",
    )
    .then((choice) => {
      if (choice === "Refresh") {
        void vscode.commands.executeCommand("day.refresh");
      } else if (choice === "Reload Window") {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
}
