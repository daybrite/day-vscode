import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  TARGETS, catalog, setCatalog, findTarget, supportTier, isDeprecated,
  tierLabel, tierDetail, optionSupport, orderTargetNames,
} from '../out/targets.js';

afterEach(() => setCatalog(undefined));

test('the fallback covers every documented tier, with WinUI replacing system XAML', () => {
  assert.equal(supportTier(findTarget('windows-winui')), 2);
  assert.equal(supportTier(findTarget('windows-xaml')), 5);
  assert.equal(isDeprecated(findTarget('windows-xaml')), true);
  assert.match(tierDetail(findTarget('windows-xaml')), /Use windows-winui/);
  assert.deepEqual([...new Set(TARGETS.map(supportTier))].sort(), [1, 2, 3, 4, 5]);
  for (const target of TARGETS) {
    assert.match(tierLabel(target), /^Tier [1-5] · /);
  }
});

test('older CLI catalogs get tier annotations without inventing unsupported choices', () => {
  setCatalog([{ name: 'windows-xaml', toolkit: 'xaml', kind: 'desktop', host: 'windows' }]);
  assert.deepEqual(catalog().map(t => t.name), ['windows-xaml']);
  assert.equal(findTarget('windows-winui'), undefined);
  assert.equal(supportTier(findTarget('windows-xaml')), 5);
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
    { name: 'windows-xaml', toolkit: 'xaml', kind: 'desktop', host: 'any' },
    { name: 'windows-winui', toolkit: 'winui', kind: 'desktop', host: 'any' },
  ]);
  const names = ['windows-xaml', 'windows-winui', 'unknown-new-target'];
  assert.deepEqual(orderTargetNames(names, true), { shown: ['windows-winui', 'unknown-new-target'], hidden: 1 });
  assert.deepEqual(orderTargetNames(names, false), { shown: ['windows-winui', 'unknown-new-target', 'windows-xaml'], hidden: 0 });
  assert.deepEqual(orderTargetNames(names, true, ['windows-xaml']).shown, ['windows-winui', 'unknown-new-target', 'windows-xaml']);
  assert.deepEqual(names, ['windows-xaml', 'windows-winui', 'unknown-new-target']);
});

test('native toolkit choices explain their per-OS tiers instead of claiming one tier for GTK', () => {
  const gtk = optionSupport('gtk');
  assert.match(gtk.label, /Tier 2/);
  assert.match(gtk.label, /Tier 4/);
  assert.match(gtk.detail, /linux-gtk: Tier 2/);
  assert.match(gtk.detail, /windows-gtk: Tier 4/);
  assert.equal(optionSupport('xaml').deprecated, true);
  assert.equal(optionSupport('winui').deprecated, false);
  assert.equal(optionSupport('some-non-target-choice'), undefined);
});
