// The Day target catalog. The AUTHORITATIVE catalog comes from the installed CLI via
// `day metadata --json` (fed in through `setCatalog` when a project loads); the static TARGETS
// list below is only an offline fallback (mirroring crates/day-cli/src/targets.rs) for when no
// CLI is reachable yet. Each `<os>-<toolkit>` target declares the host OS that can build it,
// so the UI can dim/disable targets this machine can't run.

export type TargetKind = "desktop" | "iosSim" | "android" | "harmonyOs";
export type HostOs = "macos" | "linux" | "windows" | "any";

export interface Target {
  name: string;
  toolkit: string;
  kind: TargetKind;
  host: HostOs;
  /** Optional extras the CLI catalog carries (label for menus, experimental flag). */
  label?: string;
  experimental?: boolean;
}

let activeCatalog: Target[] | undefined;

/** Install the CLI-provided catalog (undefined/empty ⇒ keep the static fallback). */
export function setCatalog(catalog: Target[] | undefined): void {
  activeCatalog = catalog && catalog.length > 0 ? catalog : undefined;
}

/** The catalog in effect: the CLI's when a project has loaded, else the static fallback. */
export function catalog(): Target[] {
  return activeCatalog ?? TARGETS;
}

export const TARGETS: Target[] = [
  { name: "macos-appkit", toolkit: "appkit", kind: "desktop", host: "macos" },
  { name: "macos-gtk", toolkit: "gtk", kind: "desktop", host: "macos" },
  { name: "macos-qt", toolkit: "qt", kind: "desktop", host: "macos" },
  { name: "linux-gtk", toolkit: "gtk", kind: "desktop", host: "linux" },
  { name: "windows-winui", toolkit: "winui", kind: "desktop", host: "windows" },
  { name: "windows-qt", toolkit: "qt", kind: "desktop", host: "windows" },
  { name: "windows-gtk", toolkit: "gtk", kind: "desktop", host: "windows" },
  { name: "linux-qt", toolkit: "qt", kind: "desktop", host: "linux" },
  { name: "ios-uikit", toolkit: "uikit", kind: "iosSim", host: "macos" },
  { name: "android-mdc", toolkit: "mdc", kind: "android", host: "any" },
  { name: "ohos-arkui", toolkit: "arkui", kind: "harmonyOs", host: "any" },
];

export function findTarget(name: string): Target | undefined {
  return catalog().find((t) => t.name === name);
}

export function hostOs(): HostOs | "other" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}

/** Whether the current host can build/run this target. */
export function isBuildableHere(t: Target): boolean {
  return t.host === "any" || t.host === hostOs();
}

/** A short, human label for a target's kind (shown as the tree item description). */
export function kindLabel(t: Target): string {
  switch (t.kind) {
    case "desktop":
      return "desktop";
    case "iosSim":
      return "iOS simulator";
    case "android":
      return "Android";
    case "harmonyOs":
      return "HarmonyOS";
  }
}
