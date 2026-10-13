import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectsAfterScan } from '../out/projectState.js';

// Synthetic projects and failures; no real CLI, network, or VS Code host is involved.
const a = { root: '/fixture/a', name: 'a', id: 'fixture.a', targets: ['macos-appkit'] };
const b = { root: '/fixture/b', name: 'b', id: 'fixture.b', targets: ['macos-appkit'] };
const failure = root => ({ root, command: 'fixture metadata', message: 'synthetic timeout', notFound: false });

test('simultaneous metadata timeouts retain both known projects', () => {
  const scan = { projects: [], failures: [failure(a.root), failure(b.root)] };
  assert.deepEqual(projectsAfterScan([a, b], scan), [a, b]);
  assert.equal(scan.failures.length, 2, 'failures must remain available for reporting');
  assert.deepEqual(projectsAfterScan([], scan), [], 'initial load must not invent metadata');
});

test('successful reads update metadata while failed reads keep the last successful value', () => {
  const updated = { ...a, targets: ['macos-appkit', 'macos-qt'] };
  assert.deepEqual(projectsAfterScan([a, b], { projects: [updated], failures: [failure(b.root)] }), [updated, b]);
  assert.deepEqual(projectsAfterScan([updated, b], { projects: [a, b], failures: [] }), [a, b]);
});

test('removed roots and successfully read non-apps are not retained', () => {
  assert.deepEqual(projectsAfterScan([a, b], { projects: [b], failures: [] }), [b]);
  assert.deepEqual(projectsAfterScan([a, b], { projects: [], failures: [] }), []);
});
