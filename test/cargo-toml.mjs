import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repository, lockGitSources, manifestGitSources, hasPathPatch } from '../out/cargoToml.js';

test('repository supports comments, literal strings, dotted and quoted keys', () => {
  assert.equal(repository(`[package] # comment
repository = 'https://example.com/right'
[package.metadata]
repository = "wrong"`), 'https://example.com/right');
  assert.equal(repository(`[workspace.package]
"repository" = "https://example.com/\\u0072ight"`), 'https://example.com/right');
  assert.equal(repository(`package.repository = 'right'`), 'right');
  assert.equal(repository(`# [package]\n# repository = 'wrong'`), undefined);
  assert.equal(repository(`[broken`), undefined);
});

test('only Cargo dependency tables supply git sources', () => {
  const text = `# git = "https://example.com/comment"
[package.metadata]
git = 'https://example.com/metadata'
[dependencies]
renamed = { package = 'actual', git = 'https://example.com/normal' }
[workspace.dependencies]
x.git = 'https://example.com/workspace'
[target.'cfg(windows)'.build-dependencies]
y = { git = 'https://example.com/windows' }
[dev-dependencies.z]
git = "https://example.com/dev"`;
  assert.deepEqual(new Set(manifestGitSources(text)), new Set([
    'https://example.com/normal', 'https://example.com/workspace',
    'https://example.com/windows', 'https://example.com/dev',
  ]));
});

test('lockfile sources ignore comments and unrelated fields', () => {
  assert.deepEqual(lockGitSources(`# source = "git+wrong"
[[package]]
name='a'
source='git+https://example.com/right#rev'
[[package]]
name='b'
source='registry+https://example.com/index'`), ['git+https://example.com/right#rev']);
});

test('patch detection matches actual decoded paths exactly', () => {
  assert.equal(hasPathPatch(`# /repo/local\n[build]\ntarget-dir='/repo/local'`, '/repo/app', '/repo/local'), false);
  assert.equal(hasPathPatch(`[patch.'https://example.com/lib']\na.path='../local'`, '/repo/app', '/repo/local'), true);
  assert.equal(hasPathPatch(`[patch.'https://example.com/lib']\na.path='/repo/local-other'`, '/repo/app', '/repo/local'), false);
});
