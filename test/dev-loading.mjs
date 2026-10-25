import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanCli } from '../out/scanCli.js';
import { matchingCheckouts, patchCheckouts, patchProject } from '../out/devPatch.js';

// Synthetic Cargo metadata and executables: never resolve or patch a developer's projects.
const checkouts = [
  { dir: '/repos/direct', url: 'https://example.com/direct', crates: ['direct'] },
  { dir: '/repos/transitive', url: 'https://example.com/transitive', crates: ['transitive'] },
  { dir: '/repos/workspace', url: 'https://example.com/workspace', crates: ['member'] },
  { dir: '/repos/unused', url: 'https://example.com/unused', crates: ['unused'] },
];
test('patch selection includes transitive and already-local member crates', () => {
  assert.deepEqual(matchingCheckouts('/apps/app', checkouts, [
    { source: 'git+https://EXAMPLE.com/transitive.git?branch=main#abc' },
    { source: null, manifest_path: '/repos/workspace/crates/member/Cargo.toml' },
    { source: null, manifest_path: '/repos/unused-neighbor/Cargo.toml' },
    { source: null, manifest_path: '/apps/app/Cargo.toml' },
  ], ['https://example.com/direct.git']), checkouts.slice(0, 3));
});

test('crates.io packages select the checkout that carries them, by name', () => {
  assert.deepEqual(matchingCheckouts('/apps/app', checkouts, [
    { name: 'transitive', source: 'registry+https://github.com/rust-lang/crates.io-index' },
    { name: 'serde', source: 'registry+https://github.com/rust-lang/crates.io-index' },
  ], [], ['direct']), checkouts.slice(0, 2));
});

test('Cargo packages belonging to the app are never mistaken for patch sources', () => {
  assert.deepEqual(matchingCheckouts('/repos/workspace/app', checkouts, [
    { source: null, manifest_path: '/repos/workspace/app/Cargo.toml' },
  ], []), []);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'day-loading-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const log = path.join(root, 'calls.jsonl');
  const executable = (name, body) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    return file;
  };
  const record = `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');`;
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, executable, record, calls };
}
const unix = { skip: process.platform === 'win32' };

test('a scan builds once for many projects, honors artifact paths, and rebuilds on refresh', unix, async t => {
  const f = fixture(t);
  const binary = path.join(f.root, 'custom target', 'day');
  f.executable('cargo', `${f.record}\nsetTimeout(() => console.log(JSON.stringify({reason:'compiler-artifact',target:{name:'day'},executable:${JSON.stringify(binary)}})), 30);`);
  const cli = { command: 'cargo', baseArgs: ['run', '--manifest-path', '/source with spaces/Cargo.toml', '-q', '-p', 'day-cli', '--'], cwd: f.root, display: 'cargo run' };
  const prepare = scanCli();
  const results = await Promise.all(Array.from({ length: 24 }, () => prepare({ ...cli })));
  assert.ok(results.every(result => result.command === binary && result.baseArgs.length === 0));
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0], ['build', '--manifest-path', '/source with spaces/Cargo.toml', '-q', '-p', 'day-cli', '--message-format=json-render-diagnostics']);
  await scanCli()(cli);
  assert.equal(f.calls().length, 2, 'another refresh must check source freshness');
  const installed = { command: '/installed/day', baseArgs: [], display: 'day' };
  assert.equal(await prepare(installed), installed);
  assert.equal(f.calls().length, 2);
});

test('all callers see a failed build and a later scan can recover', unix, async t => {
  const f = fixture(t);
  f.executable('cargo', `${f.record}\nprocess.stderr.write('synthetic build failure'); process.exit(1);`);
  const cli = { command: 'cargo', baseArgs: ['run', '-p', 'day-cli', '--'], cwd: f.root };
  const prepare = scanCli();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => prepare(cli)));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.stderr.includes('synthetic build failure')));
  assert.equal(f.calls().length, 1);
  f.executable('cargo', `${f.record}\nconsole.log(JSON.stringify({reason:'compiler-artifact',target:{name:'day'},executable:'/fixture/day'}));`);
  assert.equal((await scanCli()(cli)).command, '/fixture/day');
});

test('patching runs once per project, excluding duplicate day and unrelated folders', unix, async t => {
  const f = fixture(t);
  const day = path.join(f.root, 'day');
  fs.mkdirSync(day);
  const folders = [];
  for (let i = 0; i < 8; i++) {
    const folder = path.join(f.root, `piece ${i}`);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'Cargo.toml'), `[package]\nrepository='https://example.com/piece${i}'`);
    folders.push(folder);
  }
  const selected = patchCheckouts(day, [day, ...folders, folders[0]]);
  assert.equal(selected.length, 8);
  f.executable('cargo', `${f.record}\nconsole.log(JSON.stringify({packages:[{source:'git+https://example.com/piece0.git#abc'}]}));`);
  const binary = f.executable('day-bin', f.record);
  for (let i = 0; i < 3; i++) {
    const project = path.join(f.root, `project ${i}`);
    fs.mkdirSync(project);
    await patchProject(binary, day, project, selected);
  }
  assert.equal(f.calls().filter(c => c[0] === 'metadata').length, 3);
  const patches = f.calls().filter(c => c[0] === 'patch');
  assert.equal(patches.length, 3);
  assert.ok(patches.every(c => c.length === 7 && c[2] === day && c[4] === folders[0]));
});

test('failed resolution uses manifest/lock sources and drops only CLI-rejected unused sources', unix, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'Cargo.toml'), `[dependencies]\na.git='https://example.com/direct'`);
  fs.writeFileSync(path.join(f.root, 'Cargo.lock'), `[[package]]\nname='unused'\nsource='git+https://example.com/unused#abc'`);
  f.executable('cargo', `${f.record}\nprocess.exit(1);`);
  const binary = f.executable('day-bin', `${f.record}\nif (process.argv.includes('/repos/unused')) { process.stderr.write('this project takes nothing from https://example.com/unused — nothing to patch there'); process.exit(1); }`);
  await patchProject(binary, '/fixture/day', f.root, checkouts);
  const patches = f.calls().filter(c => c[0] === 'patch');
  assert.equal(patches.length, 2);
  assert.ok(patches[0].includes('/repos/unused'));
  assert.ok(!patches[1].includes('/repos/unused'));
  assert.ok(patches[1].includes('/repos/direct'));
});

test('missing crates skip only the rejected optional checkout, warn, and continue to later projects', unix, async t => {
  const f = fixture(t);
  const day = path.join(f.root, 'day');
  fs.mkdirSync(day);
  const dirs = ['charts with spaces', 'charts with spaces-extra', 'another incomplete checkout'];
  const folders = dirs.map((name, i) => {
    const dir = path.join(f.root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), `[package]\nrepository='https://example.com/piece${i}'`);
    return dir;
  });
  f.executable('cargo', `${f.record}\nconsole.log(JSON.stringify({packages:[0,1,2].map(i => ({source:'git+https://example.com/piece'+i+'#abc'}))}));`);
  const binary = f.executable('day-bin', `${f.record}
    const rejected = ${JSON.stringify([folders[0], folders[2]])}.find(dir => process.argv.includes(dir));
    if (rejected) {
      process.stderr.write('error: fixture-gallery is not in the checkout at '+rejected+' — is it the right checkout, or the wrong branch?\\n');
      process.exit(1);
    }
    require('fs').writeFileSync(require('path').join(process.argv.at(-1), 'patched.json'), JSON.stringify(process.argv.slice(2)));
  `);
  const projects = ['app', 'later app'].map(name => {
    const root = path.join(f.root, name);
    fs.mkdirSync(root);
    return root;
  });
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [
    new URL('../out/devPatch.js', import.meta.url).pathname,
    binary, day, '2', ...projects, ...folders,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /charts with spaces could not be patched in, and is not in the table/);
  assert.match(result.stderr, /fixture-gallery is not in the checkout/);
  for (const project of projects) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'patched.json'), 'utf8')),
      ['patch', '--local', day, '--local', folders[1], '--project', project]);
  }
  assert.equal(f.calls().filter(c => c[0] === 'metadata').length, 2);
  assert.equal(f.calls().filter(c => c[0] === 'patch').length, 6);
});

test('a missing crate in the required framework checkout remains fatal', unix, async t => {
  const f = fixture(t);
  f.executable('cargo', `${f.record}\nconsole.log(JSON.stringify({packages:[{source:'git+https://example.com/direct#abc'}]}));`);
  const binary = f.executable('day-bin', `${f.record}\nprocess.stderr.write('error: fixture-core is not in the checkout at /fixture/day — is it the right checkout, or the wrong branch?\\n'); process.exit(1);`);
  await assert.rejects(patchProject(binary, '/fixture/day', f.root, checkouts), /patch: 1/);
  const patches = f.calls().filter(c => c[0] === 'patch');
  assert.equal(patches.length, 1);
  assert.ok(patches[0].includes('/repos/direct'));
});

test('a genuine patch failure stops launch instead of silently dropping a source', unix, async t => {
  const f = fixture(t);
  const binary = f.executable('day-bin', `${f.record}\nprocess.exit(2);`);
  await assert.rejects(patchProject(binary, '/fixture/day', f.root, []), /patch: 2/);
  assert.equal(f.calls().length, 1);
});

test('the actual launcher handles spaced paths, duplicates, and a welcome-only workspace', unix, async t => {
  const f = fixture(t);
  const ext = path.join(f.root, 'extension with spaces');
  const day = path.join(f.root, 'day');
  fs.mkdirSync(path.join(ext, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(ext, 'src'));
  fs.mkdirSync(path.join(day, 'crates', 'day-cli'), { recursive: true });
  fs.mkdirSync(path.join(day, 'target', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(day, 'crates', 'day-cli', 'Cargo.toml'), '');
  fs.copyFileSync(new URL('../scripts/dev.sh', import.meta.url), path.join(ext, 'scripts', 'dev.sh'));
  for (const source of ['devPatch.ts', 'cargoToml.ts']) {
    fs.copyFileSync(new URL(`../src/${source}`, import.meta.url), path.join(ext, 'src', source));
  }
  fs.symlinkSync(new URL('../node_modules', import.meta.url).pathname, path.join(ext, 'node_modules'));
  const binary = f.executable('fixture-day', f.record);
  fs.copyFileSync(binary, path.join(day, 'target', 'debug', 'day'));
  f.executable('cargo', f.record);
  f.executable('npm', '');
  f.executable('code', f.record);
  const app = path.join(f.root, 'App With Spaces');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'Day.toml'), '');
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  execFileSync('/bin/bash', [path.join(ext, 'scripts', 'dev.sh'), day, app, app], { cwd: f.root, env });
  const workspacePath = path.join(ext, 'build', 'day-dev.code-workspace');
  const workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
  assert.deepEqual(workspace.folders.map(f => f.path), [app, day]);
  assert.equal(f.calls().filter(c => c[0] === 'patch').length, 1);
  assert.ok(f.calls().some(c => c[0] === '--new-window' && c.at(-1) === workspacePath));
  execFileSync('/bin/bash', [path.join(ext, 'scripts', 'dev.sh')], { cwd: f.root, env });
  const welcome = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
  assert.equal(welcome.settings['day.showWalkthroughOnStartup'], true);
  assert.deepEqual(welcome.folders.map(f => f.path), [day]);
  assert.equal(f.calls().filter(c => c[0] === 'patch').length, 1);
});
