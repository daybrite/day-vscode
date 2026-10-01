import * as vscode from "vscode";
import { TIER_SUMMARY } from "./targets";

export const tierHelpButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("info"),
  tooltip: TIER_SUMMARY,
};

export function showTierHelp(): void {
  void vscode.window.showInformationMessage(TIER_SUMMARY, "Platform support").then((choice) => {
    if (choice) {
      void vscode.env.openExternal(vscode.Uri.parse("https://daybrite.dev/docs/platforms#support-tiers"));
    }
  });
}
