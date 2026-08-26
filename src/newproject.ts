// Scaffolding a Day app, piece or part, asking the questions the CLI says to ask.
//
// The question set lives in `day new --describe`: every field, its options, and the flag it fills.
// Nothing here knows what a target is called or which toolkits a native piece can have — the copy
// that used to live in this extension named `windows-winui`, which is not a Day target, and it
// went unnoticed because nothing compares the two lists.
//
// The steps are native QuickPick/InputBox prompts rather than a webview, with a Back button so a
// typo three questions ago does not mean starting over. VS Code's own `showQuickPick` has no Back,
// so the inputs are built with `createQuickPick`/`createInputBox` and driven by the loop below.

import * as cp from "child_process";
import * as vscode from "vscode";

import { renderCommand, resolveCli } from "./cli";
import { toolchainEnv } from "./tasks";

/** One choice for a select/multi-select field. */
export interface SpecOption {
  value: string;
  label?: string;
  detail?: string;
  /** Whether this host can build it — targets only. Shown, never enforced: an app may ship to a
   *  platform it is not developed on. */
  buildable_here?: boolean;
  experimental?: boolean;
}

/** One question. `flag` is the `day new` flag it fills; a positional field fills the name. */
export interface SpecField {
  id: string;
  label: string;
  help?: string;
  type: "text" | "select" | "multi-select" | "boolean";
  flag?: string | null;
  /** How a list reaches the command line: `--toolkit a --toolkit b`, or `--toolkits a,b`. */
  list?: "repeat" | "comma";
  positional?: boolean;
  required?: boolean;
  pattern?: string;
  placeholder?: string;
  default?: string | string[];
  options?: SpecOption[];
  /** Ask this only when an earlier answer matches. */
  visible_when?: { field: string; equals: string | boolean };
}

export interface SpecKind {
  id: string;
  label: string;
  detail?: string;
  /** The argv the caller should run, before the name and flags — `["new", "app"]`. */
  command: string[];
  fields: SpecField[];
}

export interface Spec {
  schema?: number;
  host?: { os?: string; default_target?: string };
  kinds: SpecKind[];
}

type Answers = Record<string, string | string[]>;

/** What a step returned: an answer was given, the user went back, or they escaped. */
type Outcome = "ok" | "back" | "cancel";

/**
 * Ask the CLI what it needs to know. Returns `undefined` for a CLI too old to answer, which must
 * leave the command usable rather than throwing — the caller reports and stops.
 */
export function describeSpec(
  output: vscode.OutputChannel | undefined,
): Promise<Spec | undefined> {
  const cli = resolveCli();
  const args = [...cli.baseArgs, "new", "--describe"];
  return new Promise((resolve) => {
    cp.execFile(
      cli.command,
      args,
      { cwd: cli.cwd, timeout: 60_000, env: { ...process.env, ...toolchainEnv() } },
      (err, stdout, stderr) => {
        try {
          const spec = JSON.parse(stdout) as Spec;
          resolve(spec.kinds?.length ? spec : undefined);
        } catch {
          output?.appendLine(
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

/** The fields to ask for, given what has been answered so far. */
export function visibleFields(kind: SpecKind, answers: Answers): SpecField[] {
  return kind.fields.filter((f) => {
    const cond = f.visible_when;
    return !cond || answers[cond.field] === cond.equals;
  });
}

/**
 * The command line for a set of answers.
 *
 * A blank optional field is OMITTED rather than passed empty: `day new` then applies the default
 * it would have applied anyway, which is what keeps `dev.example.<name>` and the title-cased name
 * from having to be recomputed here.
 */
export function composeArgs(kind: SpecKind, answers: Answers): string[] {
  const args = [...kind.command];
  for (const field of visibleFields(kind, answers)) {
    const value = answers[field.id];
    const empty =
      value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (field.positional) {
      if (!empty) {
        args.push(String(value));
      }
      continue;
    }
    if (!field.flag || empty) {
      continue;
    }
    if (Array.isArray(value)) {
      if (field.list === "repeat") {
        for (const one of value) {
          args.push(field.flag, one);
        }
      } else {
        args.push(field.flag, value.join(","));
      }
    } else {
      args.push(field.flag, value);
    }
  }
  // Every answer is already on the command line, so a prompt here would be the CLI asking a
  // question the wizard just asked.
  args.push("--no-input");
  return args;
}

/** A QuickPick with a Back button. Resolves to the picked values, or why it ended. */
function pick(
  title: string,
  step: number,
  total: number,
  items: vscode.QuickPickItem[],
  many: boolean,
  canGoBack: boolean,
  placeholder?: string,
): Promise<string[] | Outcome> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = title;
    qp.step = step;
    qp.totalSteps = total;
    qp.items = items;
    qp.canSelectMany = many;
    qp.placeholder = placeholder;
    qp.ignoreFocusOut = true;
    qp.buttons = canGoBack ? [vscode.QuickInputButtons.Back] : [];
    qp.selectedItems = items.filter((i) => i.picked);
    let done: Outcome | string[] = "cancel";
    qp.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        done = "back";
        qp.hide();
      }
    });
    qp.onDidAccept(() => {
      const chosen = many ? qp.selectedItems : qp.activeItems;
      if (chosen.length > 0) {
        done = chosen.map((i) => i.label);
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(done);
    });
    qp.show();
  });
}

/** An InputBox with a Back button and live validation. */
function input(
  title: string,
  step: number,
  total: number,
  field: SpecField,
  current: string,
  canGoBack: boolean,
): Promise<string | Outcome> {
  const re = field.pattern ? new RegExp(field.pattern) : undefined;
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = title;
    box.step = step;
    box.totalSteps = total;
    box.value = current;
    box.prompt = field.help;
    box.placeholder = field.placeholder;
    box.ignoreFocusOut = true;
    box.buttons = canGoBack ? [vscode.QuickInputButtons.Back] : [];
    const problem = (v: string): string | undefined => {
      const text = v.trim();
      if (text.length === 0) {
        // Blank is how you accept the CLI's own default, so it is only an error when required.
        return field.required ? `${field.label} is required` : undefined;
      }
      return re && !re.test(text) ? `does not match ${field.pattern}` : undefined;
    };
    let done: Outcome | string = "cancel";
    box.onDidChangeValue((v) => {
      box.validationMessage = problem(v);
    });
    box.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        done = "back";
        box.hide();
      }
    });
    box.onDidAccept(() => {
      const message = problem(box.value);
      if (message) {
        box.validationMessage = message;
        return;
      }
      done = box.value.trim();
      box.hide();
    });
    box.onDidHide(() => {
      box.dispose();
      resolve(done);
    });
    box.show();
  });
}

/** Whether an option was marked as one this host cannot build. */
const foreign = (i: vscode.QuickPickItem): boolean => Boolean(i.detail?.includes("not buildable"));

function optionItems(field: SpecField, answers: Answers): vscode.QuickPickItem[] {
  const chosen = answers[field.id];
  const already = Array.isArray(chosen) ? chosen : chosen ? [chosen] : undefined;
  const preset = already ?? (Array.isArray(field.default) ? field.default : [field.default ?? ""]);
  return (field.options ?? [])
    .map((o) => ({
      label: o.value,
      description: [o.label, o.experimental ? "experimental" : undefined]
        .filter(Boolean)
        .join(" · "),
      detail:
        o.buildable_here === false
          ? `${o.detail ?? ""} — not buildable on this host`.trim()
          : o.detail,
      picked: preset.includes(o.value),
    }))
    // What this machine can build first. The rest stay pickable: an app may ship to a platform
    // it is not developed on, and CI is where those get built.
    .sort((a, b) => Number(foreign(a)) - Number(foreign(b)));
}

/**
 * Walk the questions for one kind, with Back.
 *
 * The order is recomputed each turn because it can CHANGE as answers arrive — choosing a native
 * piece adds the toolkit question — so a fixed step list would either skip it or leave a dead
 * step in the counter.
 */
export async function askAll(
  spec: Spec,
): Promise<{ kind: SpecKind; answers: Answers } | undefined> {
  const answers: Answers = {};
  let kind: SpecKind | undefined;
  let at = 0;
  for (;;) {
    const fields = kind ? visibleFields(kind, answers) : [];
    const total = 1 + fields.length;
    if (at === 0) {
      const picked = await pick(
        "Day: New Project — what to create",
        1,
        total,
        spec.kinds.map((k) => ({
          label: k.label,
          description: k.id,
          detail: k.detail,
          picked: k.id === kind?.id,
        })),
        false,
        false,
        "App, Piece or Part",
      );
      if (picked === "cancel" || picked === "back") {
        return undefined;
      }
      const chosen = spec.kinds.find((k) => k.label === (picked as string[])[0]);
      if (chosen && chosen.id !== kind?.id) {
        // A different kind asks different questions; keeping the old answers would carry a value
        // into a field that means something else.
        for (const key of Object.keys(answers)) {
          delete answers[key];
        }
      }
      kind = chosen;
      at = 1;
      continue;
    }
    if (!kind || at > fields.length) {
      return kind ? { kind, answers } : undefined;
    }

    const field = fields[at - 1];
    const title = `Day: New ${kind.label} — ${field.label}`;
    let outcome: Outcome = "ok";
    if (field.type === "text") {
      const got = await input(title, at + 1, total, field, String(answers[field.id] ?? ""), true);
      if (got === "back" || got === "cancel") {
        outcome = got;
      } else {
        answers[field.id] = got;
      }
    } else {
      const many = field.type === "multi-select";
      const items = optionItems(field, answers);
      const got = await pick(title, at + 1, total, items, many, true, field.help);
      if (got === "back" || got === "cancel") {
        outcome = got;
      } else {
        answers[field.id] = many ? got : got[0];
      }
    }
    if (outcome === "cancel") {
      return undefined;
    }
    at += outcome === "back" ? -1 : 1;
  }
}
