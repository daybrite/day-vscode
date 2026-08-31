// A TaskProvider for the `day` task type. It auto-detects build/launch tasks for EVERY project in
// the window (so they appear under "Run Task…"), and resolves tasks written by hand in tasks.json.
// This is the standard-conventions hook: `day` tasks integrate with the Tasks system,
// Ctrl+Shift+B, and key bindings.
//
// Every project, not just the focused one: "Run Task…" is how a second app gets built without
// first being focused, and each task carries its own project's mode, so the list stays honest
// about what each one will do.

import * as vscode from "vscode";

import { State } from "./config";
import { DayProject } from "./project";
import { isBuildableHere, findTarget } from "./targets";
import { buildDayTask, DayTaskDefinition } from "./tasks";

export class DayTaskProvider implements vscode.TaskProvider {
  static readonly type = "day";

  constructor(
    private readonly state: State,
    private readonly currentProject: () => DayProject | undefined,
    private readonly projects: () => DayProject[],
  ) {}

  provideTasks(): vscode.Task[] {
    const tasks: vscode.Task[] = [];
    for (const project of this.projects()) {
      // Each project's OWN mode: a release-mode app next to a debug-mode one must not have the
      // focused project's choice put in its task's command line.
      const selection = this.state.selectionFor(project.root);
      const profile = selection.profile;
      for (const name of project.targets) {
        const target = findTarget(name);
        if (!target || !isBuildableHere(target)) {
          continue;
        }
        for (const command of ["launch", "build"] as const) {
          // One launch task per configured device, so "Run Task…" offers the same set the sidebar
          // shows rather than fanning out to every connected phone. A build is device-independent,
          // and a target with nothing configured keeps its single task on the CLI's own default.
          const configured = command === "launch" ? (selection.deviceList?.[name] ?? []) : [];
          const devices = configured.length > 0 ? configured : [undefined];
          for (const device of devices) {
            tasks.push(
              buildDayTask({
                type: "day",
                command,
                target: name,
                profile,
                project: project.root,
                device,
              }),
            );
          }
        }
      }
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as DayTaskDefinition;
    if (def.type !== "day" || !def.target || (def.command !== "build" && def.command !== "launch")) {
      return undefined;
    }
    // HARD API RULE: the resolved Task must reuse the EXACT TaskDefinition object it was
    // given — a copy makes VS Code fail to match the task and silently ignore it. The project
    // default is applied to the ARGS only, inside buildDayTask.
    return buildDayTask(def, { projectFallback: this.currentProject()?.root });
  }
}
