import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FIXTURE_TARGETS, hostCombo } from './e2e/fixture.mjs';

let savedCombo;
beforeEach(() => {
  savedCombo = process.env.DAY_E2E_COMBO;
  delete process.env.DAY_E2E_COMBO;
});
afterEach(() => {
  if (savedCombo === undefined) delete process.env.DAY_E2E_COMBO;
  else process.env.DAY_E2E_COMBO = savedCombo;
});

test('every desktop host defaults to a target present in the shared fixture', () => {
  for (const [host, combo] of Object.entries({
    darwin: 'macos-appkit', win32: 'windows-winui', linux: 'linux-gtk',
  })) {
    assert.equal(hostCombo(host), combo);
    assert.ok(FIXTURE_TARGETS.includes(combo), `fixture missing ${combo}`);
  }
});

test('the WinUI CI override has matching fixture tasks', () => {
  process.env.DAY_E2E_COMBO = 'windows-winui';
  assert.ok(FIXTURE_TARGETS.includes(hostCombo()));
});

test('an explicit legacy target override remains available', () => {
  process.env.DAY_E2E_COMBO = 'windows-xaml';
  assert.equal(hostCombo('win32'), 'windows-xaml');
});
