import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapEnvOverrides } from '../out/snapEnv.js';

test('an environment without snap traces needs no overrides', () => {
  assert.deepEqual(snapEnvOverrides({
    LD_LIBRARY_PATH: '/opt/qt/lib',
    XDG_DATA_DIRS: '/usr/share:/var/lib/snapd/desktop',
    PATH: '/snap/bin:/usr/bin',
  }), {});
});

test('snap runtime entries are dropped and the rest kept in order', () => {
  assert.deepEqual(snapEnvOverrides({
    LD_LIBRARY_PATH: '/snap/core20/current/lib/x86_64-linux-gnu:/opt/qt/lib',
    GIO_MODULE_DIR: '/snap/code/200/usr/lib/x86_64-linux-gnu/gio/modules',
    LD_PRELOAD: '/snap/code/200/lib/a.so /usr/lib/b.so',
  }), {
    LD_LIBRARY_PATH: '/opt/qt/lib',
    GIO_MODULE_DIR: '',
    LD_PRELOAD: '/usr/lib/b.so',
  });
});

test('saved pre-snap values are restored, then scrubbed', () => {
  assert.deepEqual(snapEnvOverrides({
    GTK_PATH: '/snap/code/200/usr/lib/x86_64-linux-gnu/gtk-3.0',
    GTK_PATH_VSCODE_SNAP_ORIG: '',
    XDG_DATA_DIRS: '/snap/code/200/usr/share:/usr/share',
    XDG_DATA_DIRS_VSCODE_SNAP_ORIG: '/usr/local/share:/usr/share',
    LD_LIBRARY_PATH: '/snap/core20/current/lib',
    LD_LIBRARY_PATH_VSCODE_SNAP_ORIG: '/snap/other/lib:/opt/lib',
  }), {
    GTK_PATH_VSCODE_SNAP_ORIG: '',
    GTK_PATH: '',
    XDG_DATA_DIRS_VSCODE_SNAP_ORIG: '',
    XDG_DATA_DIRS: '/usr/local/share:/usr/share',
    LD_LIBRARY_PATH_VSCODE_SNAP_ORIG: '',
    LD_LIBRARY_PATH: '/opt/lib',
  });
});
