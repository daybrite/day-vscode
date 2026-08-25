// `day lint` as editor diagnostics, with the repairs the CLI proposed offered as quick fixes.
//
// The CLI is the only thing that knows the rules. It reports each finding with a file, a line, a
// severity and — for the few rules whose repair is safe and unambiguous — the exact replacement
// text. This module does no analysis of its own: it maps that envelope onto VS Code's
// DiagnosticCollection and CodeActionProvider, and applies fixes as workspace edits so they land
// in the undo stack instead of behind the editor's back.
//
// Findings are keyed by PROJECT. A workspace can hold a dozen Day apps, and linting one must not
// clear another's squiggles — every project owns the URIs its own last run produced, and only
// those are replaced when it runs again.

import * as cp from "child_process";
import * as vscode from "vscode";

import { lintArgs, renderCommand, resolveCli } from "./cli";
import { toolchainEnv } from "./tasks";

/** A repair the CLI is confident enough to apply unattended. Replaces `file` whole. */
export interface LintFix {
  title: string;
  file: string;
  contents: string;
}

/** One finding from `day lint --json`. Read leniently — the envelope is grow-only. */
export interface LintFinding {
  code: string;
  severity?: "error" | "warning";
  message: string;
  waived?: boolean;
  file?: string;
  line?: number;
  column?: number;
  fix?: LintFix;
}

interface Envelope {
  schema?: number;
  findings?: LintFinding[];
  counts?: {
    errors?: number;
    warnings?: number;
    waived?: number;
    fixable?: number;
  };
}

/** What one project's last lint produced, so the next one can replace exactly it. */
interface Run {
  /** Every URI this project put diagnostics on. */
  uris: string[];
  /** Fixes by URI, then by `code@line` — how a code action finds the repair for a diagnostic. */
  fixes: Map<string, Map<string, LintFix>>;
}

const SOURCE = "day lint";

/** How a diagnostic and its fix find each other across the code-action boundary, where the
 *  Diagnostic objects VS Code hands back are not the ones we created. */
const keyOf = (code: string, line: number): string => `${code}@${line}`;

/**
 * Turn one project's findings into the diagnostics an editor draws and the fixes a code action
 * offers, both keyed by URI.
 *
 * Separate from publishing so the mapping — 1-based to 0-based, severity, which findings are
 * squiggled at all — can be exercised without a CLI to run or a collection to write to.
 */
export function mapFindings(
  root: string,
  findings: LintFinding[],
): {
  diagnostics: Map<string, vscode.Diagnostic[]>;
  fixes: Map<string, Map<string, LintFix>>;
} {
  const diagnostics = new Map<string, vscode.Diagnostic[]>();
  const fixes = new Map<string, Map<string, LintFix>>();
  for (const f of findings) {
    // A waived code is reported so a TOOL can see that an `--allow` is still in force, but it is
    // not a problem the author needs squiggled — that is what waiving it meant.
    if (f.waived || !f.file) {
      continue;
    }
    const uri = vscode.Uri.joinPath(
      vscode.Uri.file(root),
      ...f.file.split("/"),
    );
    const line = Math.max(0, (f.line ?? 1) - 1);
    const column = Math.max(0, (f.column ?? 1) - 1);
    // To the end of the line: the CLI reports where a finding STARTS, and a squiggle under one
    // character is easy to miss. VS Code clamps the end to the real line length.
    const range = new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER);
    const diagnostic = new vscode.Diagnostic(
      range,
      f.message,
      f.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = SOURCE;
    diagnostic.code = f.code;
    const key = uri.toString();
    diagnostics.set(key, [...(diagnostics.get(key) ?? []), diagnostic]);
    // Only a fix that rewrites the file it is reported in can be offered as a quick fix on that
    // file. Every rule works that way today; a cross-file repair would need its own affordance
    // rather than a surprising edit somewhere the author is not looking.
    if (f.fix && f.fix.file === f.file) {
      const forUri = fixes.get(key) ?? new Map<string, LintFix>();
      forUri.set(keyOf(f.code, line), f.fix);
      fixes.set(key, forUri);
    }
  }
  return { diagnostics, fixes };
}

export class Lint {
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection("day");
  private readonly runs = new Map<string, Run>();

  constructor(private readonly output: vscode.OutputChannel) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  /**
   * Lint one project and publish its findings. Returns the counts for the caller to report, or
   * `undefined` if the CLI could not be run at all.
   */
  async run(root: string): Promise<Envelope["counts"] | undefined> {
    const doc = await this.invoke(root);
    if (!doc) {
      return undefined;
    }
    this.publish(root, doc.findings ?? []);
    return doc.counts ?? {};
  }

  /** Forget one project's findings — on a refresh, or when its folder leaves the workspace. */
  clear(root: string): void {
    for (const uri of this.runs.get(root)?.uris ?? []) {
      this.diagnostics.delete(vscode.Uri.parse(uri));
    }
    this.runs.delete(root);
  }

  /** The fix for one diagnostic, if the rule proposed one. */
  fixFor(uri: vscode.Uri, code: string, line: number): LintFix | undefined {
    for (const run of this.runs.values()) {
      const found = run.fixes.get(uri.toString())?.get(keyOf(code, line));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Every fix that applies to one file. `Fix all in file` needs the whole set, not one. */
  fixesIn(uri: vscode.Uri): LintFix[] {
    const out: LintFix[] = [];
    for (const run of this.runs.values()) {
      out.push(...(run.fixes.get(uri.toString())?.values() ?? []));
    }
    return out;
  }

  /** Which project a file belongs to, for re-linting after a fix lands. */
  projectOf(uri: vscode.Uri): string | undefined {
    for (const [root, run] of this.runs) {
      if (run.fixes.has(uri.toString()) || run.uris.includes(uri.toString())) {
        return root;
      }
    }
    return undefined;
  }

  private publish(root: string, findings: LintFinding[]): void {
    this.clear(root);
    const { diagnostics, fixes } = mapFindings(root, findings);
    const run: Run = { uris: [], fixes };
    for (const [key, list] of diagnostics) {
      this.diagnostics.set(vscode.Uri.parse(key), list);
      run.uris.push(key);
    }
    this.runs.set(root, run);
  }

  private invoke(root: string): Promise<Envelope | undefined> {
    const cli = resolveCli(root);
    const args = [...cli.baseArgs, ...lintArgs(root)];
    return new Promise((resolve) => {
      cp.execFile(
        cli.command,
        args,
        {
          cwd: cli.cwd ?? root,
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, ...toolchainEnv() },
        },
        (err, stdout, stderr) => {
          // `day lint` exits non-zero only under --strict, which this never passes — so an error
          // here is a CLI that could not run, and the envelope is worth trying to read anyway in
          // case the exit code came from somewhere else.
          try {
            resolve(JSON.parse(stdout) as Envelope);
            return;
          } catch {
            this.output.appendLine(
              `✗ ${renderCommand(cli, args.slice(cli.baseArgs.length))}: ${
                stderr.trim() || err?.message || "no JSON on stdout"
              }`,
            );
            resolve(undefined);
          }
        },
      );
    });
  }
}

/**
 * Turn a fix into an edit against a document we already have open.
 *
 * A whole-file replacement rather than a ranged one: the CLI computed the new contents from the
 * file as it was on disk, and reconciling that against a range would mean re-deriving what
 * changed. Going through a WorkspaceEdit keeps the change undoable and lets the editor apply it
 * to an unsaved buffer.
 */
export function editFor(
  document: vscode.TextDocument,
  fix: LintFix,
): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  edit.replace(document.uri, whole, fix.contents);
  return edit;
}

/** Offers each finding's repair on its own line, plus one action that applies them all. */
export class LintActions implements vscode.CodeActionProvider {
  static readonly kinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.SourceFixAll,
  ];

  constructor(private readonly lint: Lint) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SOURCE || typeof diagnostic.code !== "string") {
        continue;
      }
      const fix = this.lint.fixFor(
        document.uri,
        diagnostic.code,
        diagnostic.range.start.line,
      );
      if (!fix) {
        continue;
      }
      const action = new vscode.CodeAction(
        fix.title,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.edit = editFor(document, fix);
      // VS Code runs the command AFTER applying the edit. Every fix is a whole-file rewrite
      // computed from the text as it was, so a second one still holding the old contents would
      // undo this one — re-linting drops those stale fixes before anyone can click them.
      action.command = {
        command: "day.relintAfterFix",
        title: "Re-check",
        arguments: [document.uri],
      };
      actions.push(action);
    }

    // One "fix all" only when there is more than one thing to fix — with a single finding it
    // would just be the same action worded twice.
    const all = this.lint.fixesIn(document.uri);
    if (all.length > 1) {
      const action = new vscode.CodeAction(
        `Fix all ${all.length} day lint findings in this file`,
        vscode.CodeActionKind.SourceFixAll,
      );
      action.command = {
        command: "day.fixAllInFile",
        title: "Fix all",
        arguments: [document.uri],
      };
      actions.push(action);
    }
    return actions;
  }
}
