// The Day status-bar cockpit (the Flutter "status bar as cockpit" pattern): everything you need
// to see at a glance — WHAT will run (targets), HOW (mode, locale, script), and what IS running —
// with one-click affordances and a rich hover that can drive every per-target action directly.
//
//   ▶ | ⬡ appkit · gtk +1 | gear debug | globe fr
//
// Items (right-to-left priority): run/stop toggle, target picker, build mode, run context
// (locale + dayscript, shown only when set). Every item carries a trusted-Markdown tooltip whose
// command links act without opening a picker first.

import * as vscode from "vscode";

import { resolveCli } from "./cli";
import { State } from "./config";
import { DayProject } from "./project";
import { Runner } from "./runner";
import { findTarget, isBuildableHere } from "./targets";

/** `command:` link with JSON args, for trusted Markdown tooltips. */
function cmd(command: string, ...args: unknown[]): string {
  return args.length
    ? `command:${command}?${encodeURIComponent(JSON.stringify(args))}`
    : `command:${command}`;
}

/** The short display form of a target name: its toolkit half (`macos-appkit` → `appkit`). */
function short(name: string): string {
  return name.split("-").slice(1).join("-") || name;
}

export class StatusBar implements vscode.Disposable {
  private run: vscode.StatusBarItem;
  private targets: vscode.StatusBarItem;
  private mode: vscode.StatusBarItem;
  private context: vscode.StatusBarItem;
  private subs: vscode.Disposable[] = [];

  constructor(
    private readonly state: State,
    private readonly runner: Runner,
    private readonly project: () => DayProject | undefined,
  ) {
    // Ids + names make each item individually hideable via the status-bar context menu.
    this.run = vscode.window.createStatusBarItem("day.run", vscode.StatusBarAlignment.Left, 103);
    this.run.name = "Day: Run / Stop";
    this.targets = vscode.window.createStatusBarItem("day.targets", vscode.StatusBarAlignment.Left, 102);
    this.targets.name = "Day: Targets";
    this.mode = vscode.window.createStatusBarItem("day.mode", vscode.StatusBarAlignment.Left, 101);
    this.mode.name = "Day: Build Mode";
    this.context = vscode.window.createStatusBarItem("day.context", vscode.StatusBarAlignment.Left, 100);
    this.context.name = "Day: Locale / Script";
    this.subs.push(this.run, this.targets, this.mode, this.context);
    this.subs.push(state.onDidChange(() => this.update()));
    this.subs.push(runner.onDidChange(() => this.update()));
    this.update();
  }

  update(): void {
    const project = this.project();
    if (!project) {
      for (const item of [this.run, this.targets, this.mode, this.context]) {
        item.hide();
      }
      return;
    }
    const sel = this.state.selection;
    const running = this.runner.runningTargets();

    // ---- run / stop toggle -------------------------------------------------
    if (running.length > 0) {
      this.run.text = running.length > 1 ? `$(debug-stop) ${running.length}` : "$(debug-stop)";
      this.run.command = "day.stopAll";
    } else {
      this.run.text = "$(play)";
      this.run.command = "day.run";
    }
    this.run.tooltip = this.runTooltip(project, running);
    this.run.show();

    // ---- targets -----------------------------------------------------------
    const chosen = sel.targets;
    if (chosen.length === 0) {
      this.targets.text = "$(vm) pick targets";
      this.targets.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      const shorts = chosen.map(short);
      const label =
        shorts.length <= 2 ? shorts.join(" · ") : `${shorts.slice(0, 2).join(" · ")} +${shorts.length - 2}`;
      const spin = running.length > 0 ? "$(sync~spin) " : "";
      this.targets.text = `${spin}$(vm) ${label}`;
      this.targets.backgroundColor = undefined;
    }
    this.targets.tooltip = this.targetsTooltip(project, running);
    this.targets.command = "day.selectTargets";
    this.targets.show();

    // ---- mode ---------------------------------------------------------------
    this.mode.text = sel.profile === "release" ? "$(gear) release" : "$(gear) debug";
    {
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**Day build mode**\n\n`);
      for (const p of ["debug", "release"] as const) {
        const mark = p === sel.profile ? "$(pass-filled)" : "$(circle-large-outline)";
        md.appendMarkdown(`${mark} [${p}](${cmd("day.setMode", p)})\n\n`);
      }
      this.mode.tooltip = md;
    }
    this.mode.command = "day.selectMode";
    this.mode.show();

    // ---- run context (locale + script) — only when it changes behavior ------
    const bits: string[] = [];
    if (sel.locale) {
      bits.push(`$(globe) ${sel.locale}`);
    }
    if (sel.script) {
      bits.push(`$(beaker) ${sel.script.split("/").pop()}`);
    }
    if (bits.length > 0) {
      this.context.text = bits.join("  ");
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = true;
      md.appendMarkdown(`**Day run context**\n\n`);
      if (sel.locale) {
        md.appendMarkdown(
          `$(globe) Locale \`${sel.locale}\` — [change](${cmd("day.selectLocale")}) · [clear](${cmd("day.setLocale", "")})\n\n`,
        );
      }
      if (sel.script) {
        md.appendMarkdown(
          `$(beaker) Dayscript \`${sel.script}\` — [change](${cmd("day.selectScript")}) · [clear](${cmd("day.setScript", "")})\n\n`,
        );
      }
      this.context.tooltip = md;
      this.context.command = "day.selectLocale";
      this.context.show();
    } else {
      this.context.hide();
    }
  }

  /** The run/stop hover: what a click will do, plus the current CLI resolution. */
  private runTooltip(project: DayProject, running: string[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const sel = this.state.selection;
    if (running.length > 0) {
      md.appendMarkdown(`**Stop ${running.length} running target${running.length > 1 ? "s" : ""}**\n\n`);
    } else if (sel.targets.length > 0) {
      md.appendMarkdown(`**Run ${sel.targets.map(short).join(", ")}** (${sel.profile})\n\n`);
    } else {
      md.appendMarkdown(`**Run** — [pick targets](${cmd("day.selectTargets")}) first\n\n`);
    }
    md.appendMarkdown(`---\n\n$(terminal) \`${resolveCli(project.root).display}\``);
    return md;
  }

  /** The targets hover: one row per project target with live state + inline actions. */
  private targetsTooltip(project: DayProject, running: string[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${project.title ?? project.name ?? "Day"}** — targets\n\n`);
    const names = project.targets.length > 0 ? project.targets : this.state.selection.targets;
    for (const name of names) {
      const target = findTarget(name);
      const buildable = target ? isBuildableHere(target) : true;
      const isRunning = running.includes(name);
      const picked = this.state.selection.targets.includes(name);
      if (!buildable) {
        md.appendMarkdown(`$(circle-slash) ${name} — _not buildable on this host_\n\n`);
        continue;
      }
      const dot = isRunning ? "$(circle-filled)" : picked ? "$(circle-outline)" : "$(blank)";
      const actions = isRunning
        ? `[stop](${cmd("day.stop", name)}) · [restart](${cmd("day.restart", name)})`
        : `[run](${cmd("day.runTarget", name)}) · [build](${cmd("day.buildTarget", name)})`;
      md.appendMarkdown(`${dot} **${name}** — ${actions}\n\n`);
    }
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      `[$(checklist) choose](${cmd("day.selectTargets")}) · ` +
        `[$(run-all) run selected](${cmd("day.run")}) · ` +
        `[$(tools) build](${cmd("day.build")}) · ` +
        `[$(stethoscope) doctor](${cmd("day.doctor")})`,
    );
    return md;
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }
}
