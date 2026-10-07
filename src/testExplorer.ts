// Day tests in the editor (daybrite.dev/docs/testing): a Test Controller that finds every
// `#[day::test]` function in the window's Rust sources, lists each one once per target ticked in
// the Day view, and runs them through `day test`. The gutter icon beside a test function and the
// Test Explorer are VS Code's own; what they run is the CLI, one `day test` per project and
// target, so a test here means exactly what it means at the terminal and in CI.
//
// A test is three levels deep: project → file → test function → one child per target (and per
// ticked device of a mobile target). Running the function runs every child, which is how one
// gesture covers each enabled target; the results sit beside each other under the function, and
// a failure on one toolkit does not hide a pass on another.
//
// Debugging goes the way F5 does (debug.ts): the app is built, handed to the installed Rust
// debugger with the environment that opens its dayscript engine, and this module then speaks the
// engine's own protocol to run the tests inside it. The run waits at a breakpoint for as long as
// the person does.

import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

import { renderCommand, resolveCli } from "./cli";
import { DeviceChoice, State } from "./config";
import { buildAndPlan, pickDelegate } from "./debug";
import { DayProject } from "./project";
import { pickTargets } from "./quickpicks";
import { snapEnvOverrides } from "./snapEnv";
import { findTarget, hostDefaultTarget, tierLabel } from "./targets";
import { launchEnv, taskEnv, verbose, workspaceUri } from "./tasks";
import {
  DiscoveredTest,
  discoverTests,
  reportPath,
  reportPathFrom,
  leafId,
  testArgs,
  Verdict,
  verdictsFrom,
} from "./testing";

// ---------------------------------------------------------------------------
// The engine's wire protocol, for a run inside a debugged app
// ---------------------------------------------------------------------------

/** One newline-JSON reply from the dayscript engine (crates/day-script `Reply`). */
interface EngineReply {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  data?: unknown;
}

/**
 * A line-oriented client for the engine: one request per line, one reply per line, in order.
 * The token rides on every request, which is how the engine knows the caller is the launcher
 * that set it rather than another process on the same loopback.
 */
class EngineClient {
  private buffer = "";
  private waiting: ((line: string) => void)[] = [];

  private constructor(
    private readonly socket: net.Socket,
    private readonly token: string,
  ) {
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.waiting.shift()?.(line);
        nl = this.buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      for (const w of this.waiting.splice(0)) {
        w("");
      }
    });
  }

  /** Connect to the engine at `port`, trying until it listens or `until` resolves. The engine
   *  binds a moment after the app starts, longer under a debugger, so one refusal means nothing. */
  static async connect(
    port: number,
    token: string,
    until: Promise<void>,
  ): Promise<EngineClient | undefined> {
    let gone = false;
    void until.then(() => (gone = true));
    while (!gone) {
      const socket = await new Promise<net.Socket | undefined>((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port }, () => resolve(s));
        s.once("error", () => resolve(undefined));
      });
      if (socket) {
        return new EngineClient(socket, token);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return undefined;
  }

  /** Send one step and wait for its reply; an empty line (the socket closed) is a failed reply. */
  request(step: Record<string, unknown>): Promise<EngineReply> {
    return new Promise((resolve) => {
      this.waiting.push((line) => {
        if (!line) {
          resolve({ ok: false, error: "the app closed the engine connection" });
          return;
        }
        try {
          resolve(JSON.parse(line) as EngineReply);
        } catch (e) {
          resolve({ ok: false, error: `bad reply from the engine: ${e}` });
        }
      });
      this.socket.write(`${JSON.stringify({ token: this.token, step })}\n`);
    });
  }

  /** Send `step` until the engine answers something other than "try again". `run_tests` answers
   *  retryable while the tests run, which is the poll the CLI's own runner does. */
  async settle(
    step: Record<string, unknown>,
    until: Promise<void>,
    cancel: vscode.CancellationToken,
  ): Promise<EngineReply> {
    let gone = false;
    void until.then(() => (gone = true));
    for (;;) {
      const reply = await this.request(step);
      if (reply.ok || !reply.retryable || gone || cancel.isCancellationRequested) {
        return reply;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

/** A loopback port nothing listens on right now, for the engine of a debugged app. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface TestingDeps {
  state: State;
  projects: () => DayProject[];
  /** The focused project: where a test found outside every project runs (the day checkout's own
   *  cases live in `crates/day-pieces`, beside no Day.toml, and run in `apps/conformance`). */
  focused: () => DayProject | undefined;
  /** The project's ticked targets this host can build (extension.ts `runnableFor`). */
  runnableTargets: (project: DayProject) => string[];
  output: vscode.OutputChannel;
}


/** Which targets a run goes to: the Day view's ticks, or a list the person just picked. */
type TargetChoice = "selected" | string[];

/** What a test item stands for: the file it was read from and the case name it runs as. */
interface TestMeta {
  fsPath: string;
  name: string;
}

/** What a leaf item stands for: one test on one target, on one device when one is ticked. */
interface LeafMeta {
  test: vscode.TestItem;
  root: string;
  target: string;
  device?: DeviceChoice;
}

type Leaf = LeafMeta & { item: vscode.TestItem };

/** How a run ended, per leaf: what `runProject` answers, so a caller can tell without the UI. */
export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** Leaves that never got a verdict: the build failed, or the app registered no such test. */
  errored: number;
}

/** One item of the tree as a plain object: what the integration suite reads back. */
export interface TestSnapshot {
  id: string;
  label: string;
  children: TestSnapshot[];
}

const RS_EXCLUDE = "**/{node_modules,target,build,out,.git}/**";

/** How long a debugged app may take to open its engine: a debugger's startup, plus the app's. */
const ENGINE_CONNECT_MS = 180_000;

export class DayTests implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly subs: vscode.Disposable[] = [];
  /** What each Rust file declared, by path, so a tick change rebuilds the tree without re-reading. */
  private parsed = new Map<string, DiscoveredTest[]>();
  private discovered?: Promise<void>;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Item ids embed paths, and a path can hold any separator, so what an item stands for is kept
  // beside it rather than parsed back out of its id.
  private tests = new WeakMap<vscode.TestItem, TestMeta>();
  private leaves = new WeakMap<vscode.TestItem, LeafMeta>();

  constructor(private readonly deps: TestingDeps) {
    this.controller = vscode.tests.createTestController("day", "Day Tests");
    this.subs.push(this.controller);
    this.controller.resolveHandler = async (item) => {
      if (!item) {
        await this.discover();
      }
    };
    // Discovered at activation rather than when the Testing view first asks: the gutter icon on
    // a test function comes from the controller's items, and an editor opened before the view
    // showed nothing until someone visited it. A read of the window's Rust files costs little.
    void this.discover();
    this.controller.refreshHandler = () => this.discover(true);
    this.controller.createRunProfile(
      "Run on selected targets",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        await this.run(request, token, "selected", false);
      },
      true,
    );
    this.controller.createRunProfile(
      "Run on target…",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        const picked = await this.pickTargets(request);
        if (picked) {
          await this.run(request, token, picked, false);
        }
      },
    );
    this.controller.createRunProfile(
      "Debug on selected targets",
      vscode.TestRunProfileKind.Debug,
      async (request, token) => {
        await this.run(request, token, "selected", true);
      },
      true,
    );

    // The tree follows the Day view: a tick adds a target under every test, an untick removes
    // it, and a focus change re-homes the tests that belong to no project.
    this.subs.push(deps.state.onDidChange(() => this.sync()));

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.rs");
    this.subs.push(watcher);
    watcher.onDidCreate((uri) => void this.parseFile(uri.fsPath));
    watcher.onDidChange((uri) => void this.parseFile(uri.fsPath));
    watcher.onDidDelete((uri) => this.record(uri.fsPath, []));
    // The open editor is read from its buffer rather than from disk, so the gutter icon follows
    // the function as it is typed; debounced, because a keystroke is not a reason to re-read a
    // file, only a pause is.
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.parseDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== "rust") {
          return;
        }
        const key = e.document.uri.fsPath;
        clearTimeout(this.pending.get(key));
        this.pending.set(
          key,
          setTimeout(() => {
            this.pending.delete(key);
            this.parseDocument(e.document);
          }, 300),
        );
      }),
    );
  }

  dispose(): void {
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    for (const s of this.subs) {
      s.dispose();
    }
  }

  // --- discovery -----------------------------------------------------------------------------

  /** Read every Rust file in the window once; later calls reuse that unless `force`. */
  discover(force = false): Promise<void> {
    if (!this.discovered || force) {
      this.discovered = (async () => {
        const uris = await vscode.workspace.findFiles("**/*.rs", RS_EXCLUDE);
        const next = new Map<string, DiscoveredTest[]>();
        await Promise.all(
          uris.map(async (uri) => {
            try {
              const tests = discoverTests(await fs.promises.readFile(uri.fsPath, "utf8"));
              if (tests.length > 0) {
                next.set(uri.fsPath, tests);
              }
            } catch {
              // Unreadable, or gone between the listing and the read: not a test file today.
            }
          }),
        );
        this.parsed = next;
        for (const doc of vscode.workspace.textDocuments) {
          this.parseDocument(doc, false);
        }
        this.sync();
      })();
    }
    return this.discovered;
  }

  private async parseFile(fsPath: string): Promise<void> {
    if (!this.discovered) {
      return; // nothing has asked for tests yet; the first discovery reads it
    }
    try {
      this.record(fsPath, discoverTests(await fs.promises.readFile(fsPath, "utf8")));
    } catch {
      this.record(fsPath, []);
    }
  }

  private parseDocument(doc: vscode.TextDocument, sync = true): void {
    if (doc.languageId !== "rust" || doc.uri.scheme !== "file" || !this.discovered) {
      return;
    }
    this.record(doc.uri.fsPath, discoverTests(doc.getText()), sync);
  }

  private record(fsPath: string, tests: DiscoveredTest[], sync = true): void {
    const before = JSON.stringify(this.parsed.get(fsPath) ?? []);
    if (tests.length > 0) {
      this.parsed.set(fsPath, tests);
    } else {
      this.parsed.delete(fsPath);
    }
    if (sync && before !== JSON.stringify(tests)) {
      this.sync();
    }
  }

  // --- the tree --------------------------------------------------------------------------------

  /**
   * The project a Rust file's tests run in: the project whose root holds it (the longest, so a
   * nested app claims its own files), else the focused project. Both spellings of the path are
   * tried, for the same reason extension.ts `projectForUri` tries them: `day metadata` reports a
   * canonical root while the file watcher reports the path as opened.
   */
  private projectFor(fsPath: string): DayProject | undefined {
    const spellings = new Set([fsPath]);
    try {
      spellings.add(fs.realpathSync.native(fsPath));
    } catch {
      // keep the one spelling
    }
    let best: DayProject | undefined;
    for (const p of this.deps.projects()) {
      const prefix = p.root.endsWith(path.sep) ? p.root : p.root + path.sep;
      if ([...spellings].some((s) => s.startsWith(prefix)) && (!best || p.root.length > best.root.length)) {
        best = p;
      }
    }
    return best ?? this.deps.focused();
  }

  /** The targets a project's tests list: the Day view's ticks (each ticked device of a mobile
   *  target apart), or the host's own toolkit when nothing is ticked, which is what a bare
   *  `day test` runs. */
  private targetsFor(project: DayProject): { target: string; device?: DeviceChoice }[] {
    const ticked = this.deps.runnableTargets(project);
    if (ticked.length === 0) {
      return [{ target: hostDefaultTarget() }];
    }
    const out: { target: string; device?: DeviceChoice }[] = [];
    for (const target of ticked) {
      const devices = this.deps.state.devicesFor(project.root, target).length
        ? this.deps.state.tickedDevicesFor(project.root, target)
        : [];
      if (devices.length === 0) {
        out.push({ target });
      }
      for (const device of devices) {
        out.push({ target, device });
      }
    }
    return out;
  }

  /** Rebuild the tree from what is parsed: projects, files, tests, and a leaf per target. Items
   *  are kept where they already exist, so a tick change leaves earlier results in place. */
  private sync(): void {
    const byProject = new Map<string, { project: DayProject; files: string[] }>();
    for (const fsPath of [...this.parsed.keys()].sort()) {
      const project = this.projectFor(fsPath);
      if (!project) {
        continue;
      }
      const entry = byProject.get(project.root) ?? { project, files: [] };
      entry.files.push(fsPath);
      byProject.set(project.root, entry);
    }
    keep(this.controller.items, [...byProject.keys()]);
    for (const { project, files } of byProject.values()) {
      const projectItem = ensure(
        this.controller,
        this.controller.items,
        project.root,
        project.title ?? project.name,
        vscode.Uri.file(project.root),
      );
      keep(projectItem.children, files);
      // Relative to the root as the workspace spells it: the file came from the workspace, and
      // `day metadata` reports a canonical root, which on a symlinked path (macOS's /tmp) would
      // otherwise read as `../../private/tmp/…`.
      const rootHere = workspaceUri(project.root).fsPath;
      for (const fsPath of files) {
        const uri = workspaceUri(fsPath);
        const fileItem = ensure(
          this.controller,
          projectItem.children,
          fsPath,
          path.relative(rootHere, uri.fsPath),
          uri,
        );
        const tests = this.parsed.get(fsPath) ?? [];
        keep(fileItem.children, tests.map((t) => `${fsPath}#${t.fn}`));
        for (const t of tests) {
          const testItem = ensure(this.controller, fileItem.children, `${fsPath}#${t.fn}`, t.name, uri);
          testItem.range = new vscode.Range(t.line, 0, t.line, 0);
          testItem.description = t.kind === "unknown" ? undefined : t.kind;
          this.tests.set(testItem, { fsPath, name: t.name });
          const targets = this.targetsFor(project);
          keep(testItem.children, targets.map((x) => leafId(testItem.id, x.target, x.device?.id)));
          for (const x of targets) {
            this.ensureLeaf(testItem, project, x.target, x.device);
          }
        }
      }
    }
  }

  private ensureLeaf(
    test: vscode.TestItem,
    project: DayProject,
    target: string,
    device?: DeviceChoice,
  ): vscode.TestItem {
    const item = ensure(
      this.controller,
      test.children,
      leafId(test.id, target, device?.id),
      device ? `${target} · ${device.label}` : target,
    );
    item.description = tierLabel(findTarget(target));
    this.leaves.set(item, { test, root: project.root, target, device });
    return item;
  }

  // --- running -------------------------------------------------------------------------------

  /** The items a request names, or everything, less what it excludes. */
  private roots(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const named = request.include ?? [...this.controller.items].map(([, i]) => i);
    return named.filter((i) => !excluded.has(i.id));
  }

  /**
   * The leaves a run reports on. A leaf named in the request (one target's row) is itself; a
   * test, file or project named in it is every leaf beneath, on the targets `choice` says. With
   * a picked target list, a leaf is made for each picked target of each test, which is how a
   * target that is not ticked gets run once without being ticked.
   */
  private leavesIn(request: vscode.TestRunRequest, choice: TargetChoice): Leaf[] {
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const out = new Map<string, Leaf>();
    const add = (item: vscode.TestItem): void => {
      const meta = this.leaves.get(item);
      if (meta) {
        out.set(item.id, { ...meta, item });
      }
    };
    const addTest = (test: vscode.TestItem): void => {
      const meta = this.tests.get(test);
      const project = meta && this.projectFor(meta.fsPath);
      if (!project) {
        return;
      }
      const targets: { target: string; device?: DeviceChoice }[] =
        choice === "selected" ? this.targetsFor(project) : choice.map((target) => ({ target }));
      for (const t of targets) {
        add(this.ensureLeaf(test, project, t.target, t.device));
      }
    };
    const walk = (item: vscode.TestItem): void => {
      if (excluded.has(item.id)) {
        return;
      }
      const leaf = this.leaves.get(item);
      if (leaf) {
        if (choice === "selected") {
          add(item);
        } else {
          addTest(leaf.test);
        }
      } else if (this.tests.has(item)) {
        addTest(item);
      } else {
        item.children.forEach(walk);
      }
    };
    this.roots(request).forEach(walk);
    return [...out.values()];
  }

  /** The targets for a "Run on target…" run: the cockpit's own picker, over the projects the
   *  request touches, with their ticks preselected. */
  private async pickTargets(request: vscode.TestRunRequest): Promise<string[] | undefined> {
    const projects = new Set<DayProject>();
    const walk = (item: vscode.TestItem): void => {
      const meta = this.tests.get(item) ?? this.tests.get(this.leaves.get(item)?.test as vscode.TestItem);
      if (meta) {
        const p = this.projectFor(meta.fsPath);
        if (p) {
          projects.add(p);
        }
      } else {
        item.children.forEach(walk);
      }
    };
    this.roots(request).forEach(walk);
    const first = [...projects][0];
    const picked = await pickTargets(first, first ? this.deps.runnableTargets(first) : []);
    return picked && picked.length > 0 ? picked : undefined;
  }

  /** The tree as plain data: projects, files, tests and their target rows. */
  snapshot(): TestSnapshot[] {
    const of = (item: vscode.TestItem): TestSnapshot => {
      const children: TestSnapshot[] = [];
      item.children.forEach((c) => children.push(of(c)));
      return { id: item.id, label: item.label, children };
    };
    const out: TestSnapshot[] = [];
    this.controller.items.forEach((i) => out.push(of(i)));
    return out;
  }

  /** Run every test of one project on its selected targets, or on `targets`: the palette's
   *  Run Tests and the Day view's Run Tests entries. `debug` is the Debug profile's path. */
  async runProject(root: string, targets?: string[], debug = false): Promise<TestSummary> {
    await this.discover();
    const item = this.controller.items.get(root);
    if (!item) {
      const project = this.deps.projects().find((p) => p.root === root);
      void vscode.window.showInformationMessage(
        `Day: no #[day::test] functions found for ${project?.name ?? root}.`,
      );
      return { passed: 0, failed: 0, skipped: 0, errored: 0 };
    }
    const source = new vscode.CancellationTokenSource();
    return this.run(new vscode.TestRunRequest([item]), source.token, targets ?? "selected", debug);
  }

  private async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    choice: TargetChoice,
    debug: boolean,
  ): Promise<TestSummary> {
    await this.discover();
    const leaves = this.leavesIn(request, choice);
    const run = this.controller.createTestRun(request);
    const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, errored: 0 };
    try {
      for (const leaf of leaves) {
        run.enqueued(leaf.item);
      }
      // One `day test` per project and target, in turn: two builds of one project at once
      // contend for its target directory, and the output of two runs interleaved in one pane
      // reads as neither.
      const groups = new Map<string, Leaf[]>();
      for (const leaf of leaves) {
        const key = `${leaf.root}\u0000${leaf.target}\u0000${leaf.device?.id ?? ""}`;
        groups.set(key, [...(groups.get(key) ?? []), leaf]);
      }
      for (const group of groups.values()) {
        if (token.isCancellationRequested) {
          break;
        }
        const desktop = findTarget(group[0].target)?.kind === "desktop";
        if (debug && desktop && pickDelegate()) {
          await this.debugGroup(group, run, summary, token);
        } else {
          if (debug) {
            const why = desktop
              ? "no Rust debugger extension is installed"
              : "a device or browser target runs under its own runtime";
            run.appendOutput(`${group[0].target}: ${why}; running without a debugger\r\n`);
          }
          await this.runGroup(group, run, summary, token);
        }
      }
    } finally {
      run.end();
    }
    return summary;
  }

  /** The test names a group asks the CLI for: none when the group is every test of its project
   *  on that target, so the app's own registry decides, which also runs a case whose name the
   *  source did not give away. */
  private namesFor(group: Leaf[]): string[] {
    let all = 0;
    this.controller.items.get(group[0].root)?.children.forEach((file) => file.children.forEach(() => all++));
    const names = [...new Set(group.map((l) => this.tests.get(l.test)?.name ?? l.test.label))];
    return names.length >= all ? [] : names;
  }

  private async runGroup(
    group: Leaf[],
    run: vscode.TestRun,
    summary: TestSummary,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { root, target, device } = group[0];
    const sel = this.deps.state.selectionFor(root);
    const cli = resolveCli(root);
    const args = testArgs({
      projectRoot: root,
      target,
      profile: sel.profile,
      locale: sel.locale || undefined,
      env: launchEnv(root),
      shots: vscode.workspace.getConfiguration("day").get<string>("tests.shots") ?? "on-failure",
      device: device && { id: device.id, flag: device.flag },
      verbose: verbose(root),
      names: this.namesFor(group),
    });
    for (const leaf of group) {
      run.started(leaf.item);
    }
    run.appendOutput(`$ ${renderCommand(cli, args)}\r\n`);
    this.deps.output.appendLine(`[test] ${renderCommand(cli, args)}`);

    let output = "";
    const code = await new Promise<number | null>((resolve) => {
      const child = childProcess.spawn(cli.command, [...cli.baseArgs, ...args], {
        cwd: cli.cwd ?? root,
        env: { ...process.env, ...taskEnv(target) },
      });
      const sink = (d: Buffer): void => {
        const text = d.toString();
        output += text;
        run.appendOutput(text.replace(/\r?\n/g, "\r\n"));
      };
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
      child.on("error", (e) => {
        run.appendOutput(`failed to run day: ${e.message}\r\n`);
        resolve(null);
      });
      child.on("exit", (c) => resolve(c));
      // The CLI traps SIGTERM and takes the app down with it (signals.rs), which is what Stop
      // in the Day view relies on too.
      token.onCancellationRequested(() => child.kill());
    });

    let verdicts = new Map<string, Verdict>();
    const file = reportPathFrom(output) ?? reportPath(root, target, sel.locale || undefined);
    try {
      verdicts = verdictsFrom(JSON.parse(await fs.promises.readFile(file, "utf8")));
    } catch {
      // No report: the run ended before the tests did, and every leaf says so below.
    }
    this.report(group, run, summary, verdicts, path.dirname(file), code);
  }

  /**
   * Debug one project's tests on one desktop target: build for the plan the way F5 does, start
   * the delegate with the engine switched on, then run the tests through the engine and stop
   * the session when the report is in. A breakpoint holds the report, and the run with it.
   */
  private async debugGroup(
    group: Leaf[],
    run: vscode.TestRun,
    summary: TestSummary,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { root, target } = group[0];
    const sel = this.deps.state.selectionFor(root);
    const delegate = pickDelegate();
    const plan = delegate && (await buildAndPlan(root, target, sel.profile, this.deps.output));
    for (const leaf of group) {
      run.started(leaf.item);
    }
    if (!delegate || !plan) {
      const why = "the build failed, or the target has no launch plan — see the Day output channel";
      for (const leaf of group) {
        run.errored(leaf.item, new vscode.TestMessage(why));
        summary.errored++;
      }
      return;
    }
    const port = await freePort();
    const engineToken = crypto.randomBytes(16).toString("hex");
    const env: Record<string, string> = {
      ...snapEnvOverrides(process.env),
      ...plan.env,
      ...(sel.locale ? { DAY_LOCALE: sel.locale } : {}),
      ...launchEnv(root),
      DAYSCRIPT_PORT: String(port),
      DAYSCRIPT_TOKEN: engineToken,
      // What `day test` sets: motion snaps, so a drive is not timing a transition.
      DAY_TEST_FAST: "1",
    };
    const name = `Day tests: ${target} (${path.basename(root)})`;
    let session: vscode.DebugSession | undefined;
    const ended = new Promise<void>((resolve) => {
      const subs: vscode.Disposable[] = [
        vscode.debug.onDidStartDebugSession((s) => {
          if (s.name === name && !session) {
            session = s;
          }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => {
          if (s === session) {
            subs.forEach((d) => d.dispose());
            resolve();
          }
        }),
        token.onCancellationRequested(() => {
          subs.forEach((d) => d.dispose());
          resolve();
        }),
      ];
      // A session that never opens its engine must not hold the run forever.
      setTimeout(() => {
        subs.forEach((d) => d.dispose());
        resolve();
      }, ENGINE_CONNECT_MS).unref();
    });
    run.appendOutput(
      `debugging ${target} via ${delegate.label}: ${plan.program} (engine on 127.0.0.1:${port})\r\n`,
    );
    const started = await vscode.debug.startDebugging(
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)),
      { type: delegate.debugType(), request: "launch", name, ...delegate.attributes(plan, env) },
    );
    if (!started) {
      const why = `${delegate.label} refused to start for ${target} — is the ${delegate.extensionId} extension enabled?`;
      for (const leaf of group) {
        run.errored(leaf.item, new vscode.TestMessage(why));
        summary.errored++;
      }
      return;
    }

    const client = await EngineClient.connect(port, engineToken, ended);
    let verdicts = new Map<string, Verdict>();
    let error: string | undefined;
    if (!client) {
      error = "the app ended, or never opened its dayscript engine";
    } else {
      // Once connected, only the session's end or Cancel stops the wait: a breakpoint is meant
      // to hold the report for as long as the person is reading the stack.
      const sessionEnded = new Promise<void>((resolve) => {
        vscode.debug.onDidTerminateDebugSession((s) => s === session && resolve());
        token.onCancellationRequested(() => resolve());
      });
      try {
        const idle = await client.settle({ op: "wait_idle" }, sessionEnded, token);
        if (!idle.ok) {
          error = idle.error ?? "the app never went idle";
        } else {
          const reply = await client.settle(
            // No per-case limit: a breakpoint holds the case for as long as the person reads.
            { op: "run_tests", filter: this.namesFor(group), shots: "never", case_timeout_secs: 0 },
            sessionEnded,
            token,
          );
          if (reply.ok) {
            verdicts = verdictsFrom(reply.data);
          } else {
            error = reply.error ?? "run_tests failed";
          }
        }
      } finally {
        client.close();
      }
    }
    if (error) {
      run.appendOutput(`${error}\r\n`);
    }
    this.report(group, run, summary, verdicts, undefined, error ? 1 : 0);
    if (session && !token.isCancellationRequested) {
      await vscode.debug.stopDebugging(session);
    }
  }

  /** Mark each leaf from the verdicts; a leaf with no verdict was never run, and says why. */
  private report(
    group: Leaf[],
    run: vscode.TestRun,
    summary: TestSummary,
    verdicts: Map<string, Verdict>,
    shotsDir: string | undefined,
    code: number | null,
  ): void {
    for (const leaf of group) {
      const name = this.tests.get(leaf.test)?.name ?? leaf.test.label;
      const v = verdicts.get(name);
      if (!v) {
        const why =
          verdicts.size === 0
            ? `day test ended (exit ${code ?? "?"}) before any test ran — see the output`
            : `no test named "${name}" ran; the app registers its tests under the names \`day test --list\` prints`;
        run.errored(leaf.item, new vscode.TestMessage(why));
        summary.errored++;
        continue;
      }
      if (v.verdict === "pass") {
        run.passed(leaf.item, v.ms);
        summary.passed++;
      } else if (v.verdict === "skip") {
        run.appendOutput(`${name} on ${leaf.target}: skipped — ${v.reason ?? ""}\r\n`);
        run.skipped(leaf.item);
        summary.skipped++;
      } else {
        summary.failed++;
        const md = new vscode.MarkdownString(v.message ?? "failed");
        if (shotsDir && v.shots.includes("failed")) {
          const shot = vscode.Uri.file(path.join(shotsDir, "tests", name, "failed.png"));
          md.appendMarkdown(`\n\n[failed.png](${shot.toString()}) shows the screen when the assertion failed.`);
        }
        const message = new vscode.TestMessage(md);
        if (leaf.test.uri && leaf.test.range) {
          message.location = new vscode.Location(leaf.test.uri, leaf.test.range);
        }
        run.failed(leaf.item, message, v.ms);
      }
    }
  }
}

/** Drop every child whose id is not in `ids`. */
function keep(children: vscode.TestItemCollection, ids: string[]): void {
  const wanted = new Set(ids);
  const gone: string[] = [];
  children.forEach((c) => {
    if (!wanted.has(c.id)) {
      gone.push(c.id);
    }
  });
  for (const id of gone) {
    children.delete(id);
  }
}

/** The child with `id`, created with `label` when there is none; an existing one keeps its
 *  results and gets its label refreshed. */
function ensure(
  controller: vscode.TestController,
  children: vscode.TestItemCollection,
  id: string,
  label: string,
  uri?: vscode.Uri,
): vscode.TestItem {
  let item = children.get(id);
  if (!item) {
    item = controller.createTestItem(id, label, uri);
    children.add(item);
  } else if (item.label !== label) {
    item.label = label;
  }
  return item;
}
