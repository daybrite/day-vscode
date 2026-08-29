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

import { hasCargo } from "./cli";

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
  /** e.g. `["--tag", "v0.3.0"]` or `["--branch", "main"]`. */
  ref: string[];
  /** What to call this version in a message. */
  label: string;
}

const MAIN: SourceVersion = { ref: ["--branch", "main"], label: "main" };

/**
 * Whether an unset `day.cliVersion` means the newest tagged release.
 *
 * OFF for now, so the default is `main`. Day's tagged releases still trail the branch by more than
 * an app author wants — the extension regularly needs a CLI change before it is released, and this
 * whole feature exists partly to make that a setting rather than a support thread. Until releases
 * are frequent enough to be the better default, pointing everyone at `main` is the honest choice.
 *
 * FUTURE: flip this to `true` once releases are regular and stable, and change the `day.cliVersion`
 * default in package.json to `""` in the same commit — the two have to agree, since the empty
 * string is what an unset setting resolves to. The release path below is not dead in the meantime:
 * it is exercised by the integration suite through this function's third argument, so it will
 * still work on the day it is switched on.
 */
const DEFAULT_TO_NEWEST_RELEASE = false;

/**
 * Read `day.cliVersion` as git flags.
 *
 * `main` is the development branch; anything else is a tag or revision, taken literally so a
 * `v0.3.0` and a bare commit both work. Empty follows whatever the current default is — today
 * `main`, eventually the newest release, which is the only value that has to ask the network since
 * a tag list is not something the extension can know offline.
 */
export async function resolveSourceVersion(
  setting: string,
  listTags: () => Promise<string[]> = listRemoteTags,
  newestReleaseByDefault: boolean = DEFAULT_TO_NEWEST_RELEASE,
): Promise<SourceVersion> {
  const want = setting.trim();
  if (want === "main") {
    return MAIN;
  }
  if (want !== "") {
    return { ref: ["--tag", want], label: want };
  }
  if (!newestReleaseByDefault) {
    return MAIN;
  }
  const tags = await listTags();
  if (tags.length === 0) {
    throw new Error(
      `could not list releases of ${DAY_REPO} — check the network, or set day.cliVersion to a tag or to "main"`,
    );
  }
  return { ref: ["--tag", tags[0]], label: `${tags[0]} (newest release)` };
}

/** Release tags, newest first. `--sort=-v:refname` orders them as versions rather than strings. */
function listRemoteTags(): Promise<string[]> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["ls-remote", "--tags", "--refs", "--sort=-v:refname", DAY_REPO],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .map((l) => l.split("refs/tags/")[1]?.trim())
            .filter((t): t is string => !!t),
        );
      },
    );
  });
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
  /** What it does and what it needs, one line. */
  detail: string;
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

const BREW =
  "curl -LO https://github.com/daybrite/day/releases/latest/download/day.rb && " +
  "brew install --formula ./day.rb";

const CARGO = "cargo install day-cli";

/**
 * The install routes for a platform, best first.
 *
 * The release installers come first because they download a prebuilt binary: no Rust toolchain,
 * no compile. On macOS, Homebrew ranks second for people who keep everything in it.
 */
export function installRoutes(platform: NodeJS.Platform = process.platform): InstallRoute[] {
  const cargo: InstallRoute = {
    label: "cargo install day-cli",
    detail: "From crates.io. Needs a Rust toolchain, and compiles the CLI (a few minutes).",
    command: CARGO,
  };

  if (platform === "win32") {
    return [
      {
        label: "Run the Windows installer",
        detail: "Downloads a prebuilt binary and adds it to your PATH. No Rust toolchain needed.",
        command: PS_INSTALLER,
      },
      cargo,
    ];
  }

  const routes: InstallRoute[] = [
    {
      label: "Run the install script",
      detail: "Downloads a prebuilt binary into ~/.cargo/bin or ~/.local/bin. No Rust needed.",
      command: SH_INSTALLER,
    },
  ];
  if (platform === "darwin") {
    routes.push({
      label: "Install with Homebrew",
      detail: "The same binary, as a Homebrew formula. Needs brew.",
      command: BREW,
    });
  }
  return [...routes, cargo];
}

/** The docs page that explains all of this at length. */
export const DOCS_URL = "https://daybrite.dev/docs/getting-started/";

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
export async function installFromSource(globalStorage: string): Promise<void> {
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

  const setting = (
    vscode.workspace.getConfiguration("day").get<string>("cliVersion") ?? ""
  ).trim();

  let version: SourceVersion;
  try {
    version = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Day: finding the version to build",
      },
      () => resolveSourceVersion(setting),
    );
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Day: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

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

/**
 * Offer the install routes, and run the chosen one in a terminal.
 *
 * A terminal rather than a hidden child process: the command is visible, its output is visible,
 * and anything it asks for (a sudo prompt, a Homebrew confirmation) can be answered. When it
 * finishes, the caller's refresh is what picks the CLI up.
 */
export async function promptToInstall(globalStorage?: string): Promise<void> {
  const routes = installRoutes();
  const picked = await vscode.window.showQuickPick(
    [
      // Only offered when there is somewhere to put it. Listed first because it is the one route
      // the extension owns end to end: no PATH change, and `day.cliVersion` decides what it builds.
      ...(globalStorage
        ? [
            {
              label: "Build it from source (managed by this extension)",
              detail:
                "Compiles day-cli at the version `day.cliVersion` names, into this extension's own storage. Needs a Rust toolchain — which every Day app needs anyway.",
              description: "cargo install --git …",
              route: undefined,
              source: true,
            },
          ]
        : []),
      ...routes.map((r) => ({
        label: r.label,
        detail: r.detail,
        description: r.command.length > 60 ? `${r.command.slice(0, 57)}…` : r.command,
        route: r,
        source: false,
      })),
      {
        label: "Open the install instructions",
        detail: "Read them on daybrite.dev instead of running anything now.",
        description: DOCS_URL,
        route: undefined,
        source: false,
      },
    ],
    {
      title: "Install the day CLI",
      placeHolder: "The extension runs the `day` CLI; it is not installed yet",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  if (picked.source && globalStorage) {
    await installFromSource(globalStorage);
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
