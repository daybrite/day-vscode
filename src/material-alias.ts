// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

import * as vscode from "vscode";

const warned = new Set<string>();

/** Explain a legacy configuration once while loading it, without changing its target identity. */
export function warnMaterialAlias(target: string, source: string): void {
  if ((target !== "mdc" && target !== "android-mdc") || warned.has(source)) {
    return;
  }
  warned.add(source);
  void vscode.window.showWarningMessage(vscode.l10n.t(
    "The {0} target spelling is deprecated. Use android-material in {1}.", target, source,
  ));
}
