// Undo a snap-packaged VS Code's environment for the processes the extension starts directly.
//
// VS Code installed as a snap on Linux points LD_LIBRARY_PATH, GTK_PATH, GIO_MODULE_DIR and
// friends into its own runtime under /snap/, and the extension host inherits them. An app started
// with them loads the snap's older libraries instead of the system's, and a Qt app dies with
// `symbol lookup error: /snap/core20/.../libpthread.so.0: undefined symbol: __libc_pthread_init`.
// The `day` CLI scrubs its own environment the same way (day-cli ops.rs `snap_env_edits`), so
// builds and launches through it are covered; this module covers the debug sessions, which start
// the app binary without `day` in between. Keep the two in step.

/** The loader and module-path variables whose `/snap/` entries are removed. */
const SCRUBBED = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCPATH",
  "GTK_PATH",
  "GTK_EXE_PREFIX",
  "GTK_IM_MODULE_FILE",
  "GIO_MODULE_DIR",
  "GDK_PIXBUF_MODULE_FILE",
  "GDK_PIXBUF_MODULEDIR",
  "GSETTINGS_SCHEMA_DIR",
  "QT_PLUGIN_PATH",
  "QT_QPA_PLATFORM_PLUGIN_PATH",
  "LIBGL_DRIVERS_PATH",
  "__EGL_VENDOR_LIBRARY_DIRS",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
];

/** The suffix the snap launcher gives each overridden variable's saved, pre-snap value. */
const ORIG_SUFFIX = "_VSCODE_SNAP_ORIG";

/**
 * The overrides that undo a snap host's environment, to layer over the inherited one. A variable
 * that should be unset maps to "": a debug adapter merges its `env` over what it inherits and
 * cannot remove a variable, and an empty loader path means the same as none. Empty when `env`
 * shows no snap traces, which is every host but a snap-packaged VS Code.
 */
export function snapEnvOverrides(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const current: Record<string, string | undefined> = { ...env };
  const out: Record<string, string> = {};
  for (const [key, orig] of Object.entries(env)) {
    const name = key.endsWith(ORIG_SUFFIX) ? key.slice(0, -ORIG_SUFFIX.length) : "";
    if (!name || orig === undefined) {
      continue;
    }
    out[key] = "";
    if (current[name] !== orig) {
      current[name] = orig;
      out[name] = orig;
    }
  }
  for (const name of SCRUBBED) {
    const value = current[name];
    if (!value) {
      continue;
    }
    // ld.so takes LD_PRELOAD entries separated by spaces or colons; the rest are colon lists.
    const entries = value.split(name === "LD_PRELOAD" ? /[: ]/ : ":").filter((e) => e.length > 0);
    if (entries.some((e) => e.startsWith("/snap/"))) {
      out[name] = entries.filter((e) => !e.startsWith("/snap/")).join(":");
    }
  }
  return out;
}
