import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  TARGETS, catalog, setCatalog, findTarget, supportTier, isDeprecated,
  tierLabel, tierDetail, optionSupport, orderTargetNames,
} from '../out/targets.js';

afterEach(() => setCatalog(undefined));

test('the fallback covers every shipped tier, and a CLI-flagged deprecation is tier 5', () => {
  assert.equal(supportTier(findTarget('windows-winui')), 2);
  const legacy = { name: 'old-desktop', toolkit: 'old', kind: 'desktop', host: 'windows', deprecated: 'windows-winui' };
  assert.equal(supportTier(legacy), 5);
  assert.equal(isDeprecated(legacy), true);
  assert.match(tierDetail(legacy), /Use windows-winui/);
  assert.deepEqual([...new Set(TARGETS.map(supportTier))].sort(), [1, 2, 3, 4]);
  for (const target of TARGETS) {
    assert.match(tierLabel(target), /^Tier [1-5] · /);
  }
});

test('older CLI catalogs get tier annotations without inventing unsupported choices', () => {
  setCatalog([{ name: 'linux-gtk', toolkit: 'gtk', kind: 'desktop', host: 'linux' }]);
  assert.deepEqual(catalog().map(t => t.name), ['linux-gtk']);
  assert.equal(findTarget('windows-winui'), undefined);
  assert.equal(supportTier(findTarget('linux-gtk')), 2);
});

test('CLI tier metadata wins, and unknown external targets are not assigned a guessed tier', () => {
  const external = { name: 'custom-toolkit', toolkit: 'custom', kind: 'desktop', host: 'any', experimental: true };
  assert.equal(supportTier(external), undefined);
  assert.equal(tierLabel(external), 'Tier unassigned');
  assert.equal(supportTier({ ...external, tier: 2 }), 2);
  assert.equal(supportTier({ ...external, tier: 2, deprecated: 'custom-next' }), 5);
  assert.equal(supportTier({ ...findTarget('web-dom'), tier: 2 }), 2);
});

test('deprecated targets are last and hidden by default, but explicit legacy selections survive', () => {
  setCatalog([
    { name: 'old-desktop', toolkit: 'old', kind: 'desktop', host: 'any', deprecated: 'windows-winui' },
    { name: 'windows-winui', toolkit: 'winui', kind: 'desktop', host: 'any' },
  ]);
  const names = ['old-desktop', 'windows-winui', 'unknown-new-target'];
  assert.deepEqual(orderTargetNames(names, true), { shown: ['windows-winui', 'unknown-new-target'], hidden: 1 });
  assert.deepEqual(orderTargetNames(names, false), { shown: ['windows-winui', 'unknown-new-target', 'old-desktop'], hidden: 0 });
  assert.deepEqual(orderTargetNames(names, true, ['old-desktop']).shown, ['windows-winui', 'unknown-new-target', 'old-desktop']);
  assert.deepEqual(names, ['old-desktop', 'windows-winui', 'unknown-new-target']);
});

test('native toolkit choices explain their per-OS tiers instead of claiming one tier for GTK', () => {
  const gtk = optionSupport('gtk');
  assert.match(gtk.label, /Tier 2/);
  assert.match(gtk.label, /Tier 4/);
  assert.match(gtk.detail, /linux-gtk: Tier 2/);
  assert.match(gtk.detail, /windows-gtk: Tier 4/);
  setCatalog([...TARGETS, { name: 'old-desktop', toolkit: 'old', kind: 'desktop', host: 'windows', deprecated: 'windows-winui' }]);
  assert.equal(optionSupport('old').deprecated, true);
  assert.equal(optionSupport('winui').deprecated, false);
  assert.equal(optionSupport('some-non-target-choice'), undefined);
});

test('Material aliases select one canonical target and normalize older CLI catalogs', () => {
  assert.equal(findTarget('android-mdc').name, 'android-material');
  assert.equal(findTarget('mdc').toolkit, 'material');
  setCatalog([
    { name: 'android-mdc', toolkit: 'mdc', kind: 'android', host: 'any' },
    { name: 'android-material', toolkit: 'material', kind: 'android', host: 'any' },
  ]);
  assert.deepEqual(catalog().map(t => t.name), ['android-material']);
  assert.equal(catalog()[0].toolkit, 'material');
});
