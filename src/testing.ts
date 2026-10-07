// The CLI side of Day tests (daybrite.dev/docs/testing), free of the `vscode` module so the unit
// tests can load it: which functions a Rust file marks `#[day::test]`, the `day test` arguments
// for one project and target, and how a run's verdicts are read back. The Test Explorer that
// uses it is testExplorer.ts.

import * as path from "path";

import { Profile } from "./config";

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

/** One `#[day::test]` function as read from a Rust source file. */
export interface DiscoveredTest {
  /** The Rust function's name. */
  fn: string;
  /** The name `day test` knows it by: the function's, with hyphens for underscores, which is
   *  how the registry names every test. */
  name: string;
  /** Zero-based line of the `fn`. */
  line: number;
  kind: "gui" | "headless" | "unknown";
}

/** The attribute in either spelling: `#[day::test]` in an app, `#[day_macros::test(day_core)]`
 *  in a crate below `day`. */
const ATTRIBUTE = /#\[\s*(?:::)?(?:day|day_macros)::test(?:\s*\([^)]*\))?\s*\]/g;

/**
 * Every `#[day::test]` function in `source`, named the way the app's registry names it.
 *
 * A regex rather than a parser: the attribute and the `fn` after it are all the extension needs,
 * and a Rust parser would be the largest dependency in this extension for one lookup. The name
 * is the function's, hyphenated, exactly as `day test` reports it; the kind is read from whether
 * the body builds `Case::headless()` or `Case::new()`. An attribute quoted in a comment is
 * skipped, so a doc line that mentions the attribute does not claim the next function.
 */
export function discoverTests(source: string): DiscoveredTest[] {
  const out: DiscoveredTest[] = [];
  const matches = [...source.matchAll(ATTRIBUTE)].filter((m) => {
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    return !source.slice(lineStart, m.index).includes("//");
  });
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
    const region = source.slice(start, end);
    const fn = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(region);
    if (!fn) {
      continue;
    }
    const body = region.slice(fn.index);
    const built = /\bCase::(new|headless)\s*\(/.exec(body);
    const line = source.slice(0, start + fn.index).split("\n").length - 1;
    out.push({
      fn: fn[1],
      name: fn[1].replace(/_/g, "-"),
      line,
      kind: built ? (built[1] === "new" ? "gui" : "headless") : "unknown",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CLI side: `day test` arguments and what a run leaves
// ---------------------------------------------------------------------------

/** What one `day test` invocation needs: a project, a target, and the cockpit's run settings. */
export interface TestRunOptions {
  projectRoot: string;
  target: string;
  profile: Profile;
  locale?: string;
  env?: Record<string, string>;
  /** Which captures to keep (`day.tests.shots`). */
  shots?: string;
  device?: { id: string; flag: string };
  verbose?: boolean;
  /** Test names (or globs); empty runs every test the app registers. */
  names: string[];
}

/** Args for `day test` on one target: `--project` explicit for the reason every other verb's is
 *  (dev-mode runs with the day checkout as cwd), the device flag from the listing (cli.ts). */
export function testArgs(o: TestRunOptions): string[] {
  const args = [
    "--project",
    o.projectRoot,
    "test",
    "-p",
    o.target,
    "--profile",
    o.profile,
    "--shots",
    o.shots ?? "on-failure",
  ];
  if (o.locale && o.locale.length > 0) {
    args.push("--locale", o.locale);
  }
  for (const [k, v] of Object.entries(o.env ?? {})) {
    args.push("--env", `${k}=${v}`);
  }
  if (o.verbose) {
    args.push("--verbose");
  }
  if (o.device) {
    args.push(o.device.flag, o.device.id);
  }
  return [...args, ...o.names];
}

/** One test's outcome, as `conformance.json` and the `run_tests` report both spell it. */
export interface Verdict {
  verdict: "pass" | "fail" | "skip";
  ms?: number;
  message?: string;
  reason?: string;
  shots: string[];
}

// The CLI colors its report on a terminal; built from the code point so the lint that forbids a
// raw control character in a regex has nothing to object to.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The `Results <path>` line `day test` prints when a run completes, or `undefined` when the run
 *  ended before writing one (a build failure, a launch that never reached the engine). */
export function reportPathFrom(output: string): string | undefined {
  const m = /^\s*Results\s+(.+?conformance\.json)\s*$/m.exec(output.replace(ANSI, ""));
  return m ? m[1] : undefined;
}

/**
 * Verdicts by test name, from either shape the CLI produces: `conformance.json` (`tests` is an object
 * keyed by name) or a `run_tests` reply's report (`tests` is an array, each row named). Anything
 * that is not one of those reads as no verdicts, and the caller reports the tests as not run.
 */
export function verdictsFrom(doc: unknown): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const tests = (doc as { tests?: unknown } | null)?.tests;
  const read = (name: string, row: unknown): void => {
    if (!row || typeof row !== "object") {
      return;
    }
    const r = row as Record<string, unknown>;
    const verdict = r.verdict === "pass" || r.verdict === "skip" ? r.verdict : "fail";
    out.set(name, {
      verdict,
      ms: typeof r.ms === "number" ? r.ms : undefined,
      message: typeof r.message === "string" ? r.message : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
      shots: Array.isArray(r.shots) ? r.shots.filter((s): s is string => typeof s === "string") : [],
    });
  };
  if (Array.isArray(tests)) {
    for (const row of tests) {
      const name = (row as { name?: unknown } | null)?.name;
      if (typeof name === "string") {
        read(name, row);
      }
    }
  } else if (tests && typeof tests === "object") {
    for (const [name, row] of Object.entries(tests as Record<string, unknown>)) {
      read(name, row);
    }
  }
  return out;
}

/** Where `day test` writes `conformance.json` for a target when its output cannot be read: the
 *  layout docs/testing.md fixes, with no device profile (a local run names none). */
export function reportPath(root: string, target: string, locale?: string): string {
  return path.join(root, "build", "day", "screenshots", target, locale || "default", "conformance.json");
}


/** The id of a test's per-target leaf: the test's id, then the target and device after `@`. */
export function leafId(testId: string, target: string, device?: string): string {
  return device ? `${testId}@${target}@${device}` : `${testId}@${target}`;
}
