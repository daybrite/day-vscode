// The Day target catalog. The authoritative catalog comes from the installed CLI via
// `day metadata --json` (fed in through `setCatalog` when a project loads); the static TARGETS
// list below is only an offline fallback (mirroring crates/day-cli/src/targets.rs) for when no
// CLI is reachable yet. Each `<os>-<toolkit>` target declares the host OS that can build it,
// so the UI can dim/disable targets this machine can't run.

export type TargetKind = "desktop" | "iosSim" | "android" | "harmonyOs" | "web";
export type HostOs = "macos" | "linux" | "windows" | "any";
export type SupportTier = 1 | 2 | 3 | 4 | 5;

export interface Target {
  name: string;
  toolkit: string;
  kind: TargetKind;
  host: HostOs;
  /** Optional extras the CLI catalog carries (label for menus, experimental flag). */
  label?: string;
  experimental?: boolean;
  tier?: SupportTier;
  /** Replacement target, when deprecated (older CLIs omit this field). */
  deprecated?: string | null;
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
  { name: "windows-winui", toolkit: "winui", kind: "desktop", host: "windows", label: "Windows (WinUI 3)" },
  { name: "windows-xaml", toolkit: "xaml", kind: "desktop", host: "windows", deprecated: "windows-winui" },
  { name: "windows-qt", toolkit: "qt", kind: "desktop", host: "windows" },
  { name: "windows-gtk", toolkit: "gtk", kind: "desktop", host: "windows" },
  { name: "linux-qt", toolkit: "qt", kind: "desktop", host: "linux" },
  { name: "ios-uikit", toolkit: "uikit", kind: "iosSim", host: "macos" },
  { name: "android-mdc", toolkit: "mdc", kind: "android", host: "any" },
  { name: "harmony-arkui", toolkit: "arkui", kind: "harmonyOs", host: "any" },
  { name: "web-dom", toolkit: "dom", kind: "web", host: "any" },
];

// Mirrors day's documented platform support tiers. CLI-provided tiers take precedence; older
// CLIs provide only host/experimental, and experimental is not a support-tier designation.
const TIERS: Record<string, SupportTier> = {
  "macos-appkit": 1, "ios-uikit": 1, "android-mdc": 1,
  "linux-gtk": 2, "linux-qt": 2, "windows-winui": 2,
  "harmony-arkui": 3, "web-dom": 3,
  "macos-gtk": 4, "macos-qt": 4, "windows-gtk": 4, "windows-qt": 4,
  "windows-xaml": 5,
};

const TIER_NAMES: Record<SupportTier, string> = {
  1: "Supported", 2: "Demi-supported", 3: "Experimental", 4: "Development", 5: "Deprecated",
};
const TIER_MEANINGS: Record<SupportTier, string> = {
  1: "For shipping apps; full walkthrough coverage and regressions block releases.",
  2: "For shipping apps; CI coverage, with less manual testing and production use.",
  3: "For evaluation; walkthrough coverage, but no shipping applications yet.",
  4: "For compatibility testing; no release packaging.",
  5: "For existing projects only; superseded and due for removal.",
};

export const TIER_LEGEND = "Tiers: 1 Supported · 2 Demi-supported · 3 Experimental · 4 Development · 5 Deprecated";
export const TIER_SUMMARY = [
  "Tiers describe testing and maintenance, not API completeness.",
  ...([1, 2, 3, 4, 5] as const).map((tier) => `Tier ${tier} · ${TIER_NAMES[tier]}: ${TIER_MEANINGS[tier]}`),
].join("\n");

export function supportTier(target: Target): SupportTier | undefined {
  return target.deprecated ? 5 : target.tier ?? TIERS[target.name];
}

export function isDeprecated(target: Target): boolean {
  return supportTier(target) === 5;
}

export function replacementTarget(target: Target): string | undefined {
  return target.deprecated || (target.name === "windows-xaml" ? "windows-winui" : undefined);
}

export function tierLabel(target: Target | undefined): string {
  const tier = target && supportTier(target);
  return tier ? `Tier ${tier} · ${TIER_NAMES[tier]}` : "Tier unassigned";
}

export function tierDetail(target: Target | undefined): string {
  const tier = target && supportTier(target);
  const replacement = target && replacementTarget(target);
  return [
    tier ? TIER_MEANINGS[tier] : "This target has no declared support tier.",
    replacement ? `Use ${replacement} for new projects.` : undefined,
  ].filter(Boolean).join(" ");
}

/** Keep the author's order within groups, but put deprecated targets after usable alternatives. */
export function targetPreference(target: Target | undefined): number {
  return target && isDeprecated(target) ? 2 : target && !isBuildableHere(target) ? 1 : 0;
}

/** Visibility in the cockpit. Explicitly selected/running legacy targets remain controllable. */
export function orderTargetNames(names: string[], hideUnavailable: boolean, retained: string[] = []): { shown: string[]; hidden: number } {
  const shown = names.filter((name) => {
    const t = findTarget(name);
    return !hideUnavailable || !t || (isBuildableHere(t) && (!isDeprecated(t) || retained.includes(name)));
  });
  shown.sort((a, b) => targetPreference(findTarget(a)) - targetPreference(findTarget(b)));
  return { shown, hidden: names.length - shown.length };
}

/** A native toolkit (such as gtk) may have different tiers on different operating systems. */
export function optionSupport(value: string): { label: string; detail: string; deprecated: boolean } | undefined {
  // Describing annotations never adds choices: a newer `day new --describe` may name a target
  // that the last loaded project's catalog did not contain yet.
  const known = new Map([...TARGETS, ...catalog()].map((t) => [t.name, t]));
  const exact = known.get(value);
  const matches = exact ? [exact] : [...known.values()].filter((t) => t.toolkit === value);
  if (!matches.length) { return undefined; }
  const labels = [...new Set(matches.map(tierLabel))];
  return {
    label: labels.join(" / "),
    detail: matches.map((t) => `${t.name}: ${tierLabel(t)}. ${tierDetail(t)}`).join(" "),
    deprecated: matches.every(isDeprecated),
  };
}

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

/** An IDE that a target's scaffolded native project can be handed to. */
export type NativeIde = "studio" | "xcode";

/** The native project a target carries, and what opens it. */
export interface NativeProject {
  /** Suffix on the row's `contextValue`, which is what the menu's `when` clause keys on. */
  ide: NativeIde;
  /** The application's name, for `open -a` and for anything that has to say what is missing. */
  ideName: string;
  /** What to hand the IDE, relative to the project root. */
  relative: string;
}

/**
 * The native IDE project a target carries, if the scaffold wrote one for it.
 *
 * These are committed source under `platform/`, not build output (`day new` writes them and the
 * app owns them from then on), so opening one is just handing the IDE a path, with no build
 * required first. `platform` is a parameter rather than `process.platform` so the macOS-only rule
 * can be tested from any host, the way `cliSearchDirs` is.
 */
export function nativeProjectFor(
  target: string,
  platform: NodeJS.Platform,
): NativeProject | undefined {
  switch (target) {
    case "android-mdc":
      // Studio opens the Gradle root (the directory holding `settings.gradle.kts`), not the app
      // module beneath it and not a lone `build.gradle.kts`, which it would treat as a stray file.
      return {
        ide: "studio",
        ideName: "Android Studio",
        relative: "platform/android",
      };
    // The two Apple targets each scaffold their own .xcodeproj, under their own platform
    // directory. Xcode ships on macOS only, so no other host is offered a row it could not act on.
    case "ios-uikit":
    case "macos-appkit":
      return platform === "darwin"
        ? {
            ide: "xcode",
            ideName: "Xcode",
            relative:
              target === "ios-uikit"
                ? "platform/ios/DayApp.xcodeproj"
                : "platform/macos/DayApp.xcodeproj",
          }
        : undefined;
    default:
      return undefined;
  }
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
    case "web":
      return "web";
  }
}
