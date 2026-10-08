import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queuedRefresh } from '../out/refresh.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Explicit gates make overlapping watcher/command reads deterministic, without timer races.
test('a command waits for a fresh read after an in-flight watcher scan', async () => {
  let manifest = ['macos-appkit'];
  let projects;
  let calls = 0;
  const started = deferred();
  const release = deferred();
  const refresh = queuedRefresh(async () => {
    const snapshot = [...manifest];
    if (++calls === 1) {
      started.resolve();
      await release.promise;
    }
    projects = snapshot;
  });
  const watcher = refresh();
  await started.promise;
  manifest.push('macos-qt');
  const command = refresh();
  assert.notEqual(watcher, command, 'a pre-write scan cannot satisfy the command');
  release.resolve();
  await command;
  assert.deepEqual(projects, manifest, 'the added target must be visible when the command returns');
  assert.equal(calls, 2);
});

test('a burst of manifest events shares one follow-up without overlapping scans', async () => {
  const gates = [deferred(), deferred()];
  const starts = [deferred(), deferred()];
  let calls = 0;
  let inFlight = 0;
  const refresh = queuedRefresh(async () => {
    assert.equal(++inFlight, 1, 'metadata scans must never overlap');
    const i = calls++;
    starts[i].resolve();
    await gates[i].promise;
    inFlight--;
  });
  const first = refresh();
  await starts[0].promise;
  const burst = Array.from({ length: 100 }, () => refresh());
  assert.ok(burst.every(p => p === burst[0]));
  assert.equal(calls, 1);
  gates[0].resolve();
  await starts[1].promise;
  gates[1].resolve();
  await Promise.all([first, ...burst]);
  assert.equal(calls, 2);
});

test('requests at the completion boundary join the scheduled follow-up', async () => {
  let calls = 0;
  const refresh = queuedRefresh(async () => { calls++; });
  const first = refresh();
  const followUp = refresh();
  await first;
  assert.equal(refresh(), followUp);
  await followUp;
  assert.equal(calls, 2);
});

test('changes during a follow-up schedule another fresh read', async () => {
  const secondStarted = deferred();
  const releaseSecond = deferred();
  let calls = 0;
  const refresh = queuedRefresh(async () => {
    if (++calls === 2) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
  });
  const first = refresh();
  const second = refresh();
  await secondStarted.promise;
  const third = refresh();
  assert.notEqual(third, second);
  releaseSecond.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls, 3);
});

test('a failed scan rejects its callers but does not strand queued or later refreshes', async () => {
  const failure = new Error('synthetic metadata failure');
  let calls = 0;
  const refresh = queuedRefresh(async () => {
    if (++calls === 1) throw failure;
  });
  const first = refresh();
  const queued = refresh();
  await assert.rejects(first, failure);
  await queued;
  await refresh();
  assert.equal(calls, 3);
});
