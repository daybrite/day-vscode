import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverTests, reportPathFrom, reportPath, leafId, testArgs, verdictsFrom } from '../out/testing.js';
import { hostDefaultTarget } from '../out/targets.js';

// The shape crates/day-pieces/src/conformance.rs has: a module doc that mentions the attribute,
// then the crate-internal spelling with the registry crate named.
const PIECES = `//! One \`#[day::test]\` per aspect, each a page and a drive.
use day_core::conformance::{Case, Drive};

/// A button fires its action.
#[day_macros::test(day_core)]
pub fn button_status() -> Case {
    let presses = Signal::new(0i64);
    Case::new()
        .proves(kinds::BUTTON)
}

#[day_macros::test(day_core)]
pub fn headless_sanity() -> Case {
    Case::headless().run(|t: Drive| async move { t.check_eq(2 + 2, 4) })
}
`;

test('discovers the attribute in both spellings, with the case name each declares', () => {
  const found = discoverTests(PIECES);
  assert.deepEqual(found, [
    { fn: 'button_status', name: 'button-status', line: 5, kind: 'gui' },
    { fn: 'headless_sanity', name: 'headless-sanity', line: 12, kind: 'headless' },
  ]);
  const app = `use day::prelude::*;\n\n#[day::test]\nfn store_round_trip() -> Case {\n    Case::headless().run(|t| async move { t.check(true, "ok") })\n}\n`;
  assert.deepEqual(discoverTests(app), [{ fn: 'store_round_trip', name: 'store-round-trip', line: 3, kind: 'headless' }]);
});

test('a case built through a helper is listed with an unknown kind, still under its name', () => {
  const src = `#[day::test]\nfn slider_range() -> Case {\n    shared_case()\n}\n`;
  assert.deepEqual(discoverTests(src), [{ fn: 'slider_range', name: 'slider-range', line: 1, kind: 'unknown' }]);
});

test('an attribute quoted in a comment claims no function', () => {
  const src = `// a note: #[day::test] marks a case\nfn not_a_test() {}\n\n#[day::test]\nfn real() -> Case { Case::new() }\n`;
  assert.deepEqual(discoverTests(src).map((t) => t.fn), ['real']);
  assert.deepEqual(discoverTests('fn plain() {}\n#[test]\nfn unit() {}\n'), []);
});

test('day test takes the project, the target, the run settings and the names', () => {
  assert.deepEqual(
    testArgs({ projectRoot: '/app', target: 'macos-appkit', profile: 'debug', names: ['button-status'] }),
    ['--project', '/app', 'test', '-p', 'macos-appkit', '--profile', 'debug', '--shots', 'on-failure', 'button-status'],
  );
  const args = testArgs({
    projectRoot: '/app', target: 'ios-uikit', profile: 'release', locale: 'fr', env: { DAY_LOG: 'info' },
    shots: 'always', device: { id: '851CD930-9C1D', flag: '--ios-simulator' }, verbose: true, names: [],
  });
  assert.deepEqual(args, [
    '--project', '/app', 'test', '-p', 'ios-uikit', '--profile', 'release', '--shots', 'always',
    '--locale', 'fr', '--env', 'DAY_LOG=info', '--verbose', '--ios-simulator', '851CD930-9C1D',
  ]);
});

test('the report path is read from the output, colors and all, with the layout as fallback', () => {
  const out = '      button-status ..... ok (95 ms)\n      \u001b[1mResults\u001b[0m /app/build/day/screenshots/macos-appkit/default/conformance.json\n';
  assert.equal(reportPathFrom(out), '/app/build/day/screenshots/macos-appkit/default/conformance.json');
  assert.equal(reportPathFrom('error: build failed\n'), undefined);
  assert.equal(reportPath('/app', 'linux-gtk'), '/app/build/day/screenshots/linux-gtk/default/conformance.json');
  assert.equal(reportPath('/app', 'linux-gtk', 'fr-CA'), '/app/build/day/screenshots/linux-gtk/fr-CA/conformance.json');
});

test('verdicts come from conformance.json and from a run_tests report alike', () => {
  const fileShape = {
    schema: 1,
    tests: {
      'button-status': { kind: 'gui', verdict: 'pass', ms: 260, shots: ['default'] },
      'text-field-secure': { kind: 'gui', verdict: 'fail', ms: 840, message: 'assert_text tfs-len: "7" ≠ "6"', shots: ['masked', 'failed'] },
      'slider-range': { kind: 'gui', verdict: 'skip', reason: 'Cap::Animation is Unsupported', shots: [] },
    },
  };
  const fromFile = verdictsFrom(fileShape);
  assert.equal(fromFile.get('button-status').verdict, 'pass');
  assert.equal(fromFile.get('button-status').ms, 260);
  assert.equal(fromFile.get('text-field-secure').message, 'assert_text tfs-len: "7" ≠ "6"');
  assert.deepEqual(fromFile.get('text-field-secure').shots, ['masked', 'failed']);
  assert.equal(fromFile.get('slider-range').reason, 'Cap::Animation is Unsupported');

  const report = { tests: [{ name: 'button-status', verdict: 'pass', ms: 12 }, { name: 'odd', verdict: 'error', message: 'panicked' }] };
  const fromReply = verdictsFrom(report);
  assert.equal(fromReply.get('button-status').verdict, 'pass');
  assert.equal(fromReply.get('odd').verdict, 'fail');
  assert.equal(fromReply.get('odd').message, 'panicked');

  assert.equal(verdictsFrom(null).size, 0);
  assert.equal(verdictsFrom({ tests: 'nope' }).size, 0);
});

test('a leaf id carries the target and the device after the test id', () => {
  assert.equal(leafId('/a/b.rs#f', 'ios-uikit'), '/a/b.rs#f@ios-uikit');
  assert.equal(leafId('/a/b.rs#f', 'ios-uikit', 'sim-1'), '/a/b.rs#f@ios-uikit@sim-1');
});

test('the host default follows the CLI: the desktop toolkit, Qt on a Qt desktop', () => {
  const here = hostDefaultTarget({});
  assert.ok(['macos-appkit', 'windows-winui', 'linux-gtk'].includes(here), here);
  if (process.platform === 'linux') {
    assert.equal(hostDefaultTarget({ XDG_CURRENT_DESKTOP: 'KDE' }), 'linux-qt');
    assert.equal(hostDefaultTarget({ XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'plasma' }), 'linux-qt');
    assert.equal(hostDefaultTarget({ XDG_CURRENT_DESKTOP: 'GNOME' }), 'linux-gtk');
  }
});
