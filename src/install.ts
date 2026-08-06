// Helping a user get the `day` CLI, when the extension cannot find one.
//
// The extension does not ship the binary and does not install it silently. What it does is turn
// "the CLI could not be run" from a dead end into one click: pick the right command for this OS,
// explain what it will do, and offer to run it in a terminal the user can watch.
//
// Why not install it automatically: the CLI lands on PATH outside the extension's own storage,
// which is the user's machine to change, and every route below either needs a package manager
// they may not use or a shell script from the network. Running that unattended, on activation,
// because a file called Day.toml happened to be in the folder, is not a decision an extension
// should make for someone. Running it on a button press, with the command visible first, is.
//
// The commands come from the day release's own installers (rendered per release by
// scripts/release/templates in the day repository), so they stay correct as long as the release
// pipeline does. `cargo install` is listed last on purpose: it is the only route that needs a Rust
// toolchain, and someone who has not installed the CLI often has not installed Rust either.

import * as vscode from "vscode";

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
 * Offer the install routes, and run the chosen one in a terminal.
 *
 * A terminal rather than a hidden child process: the command is visible, its output is visible,
 * and anything it asks for (a sudo prompt, a Homebrew confirmation) can be answered. When it
 * finishes, the caller's refresh is what picks the CLI up.
 */
export async function promptToInstall(): Promise<void> {
  const routes = installRoutes();
  const picked = await vscode.window.showQuickPick(
    [
      ...routes.map((r) => ({
        label: r.label,
        detail: r.detail,
        description: r.command.length > 60 ? `${r.command.slice(0, 57)}…` : r.command,
        route: r,
      })),
      {
        label: "Open the install instructions",
        detail: "Read them on daybrite.dev instead of running anything now.",
        description: DOCS_URL,
        route: undefined,
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
