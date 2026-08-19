#!/usr/bin/env bash
# Launch VS Code with the LOCAL source build of the Day extension, on a workspace holding BOTH
# repositories the extension's dev loop needs.
#
#   scripts/dev.sh [path-to-day-project]
#
# The argument is the Day app to open beside `day/` — any conventional Day project, nothing here is
# specific to one. With no argument it is the nearest ancestor of the CURRENT DIRECTORY holding a
# Day.toml, the same rule `day --project` follows, so
#
#   cd ~/apps/MyApp && ~/src/day-vscode/scripts/dev.sh
#
# opens that app. The window is an Extension Development Host: the extension running there is built
# fresh from THIS working tree (superseding any installed day-vscode in that window), so source
# edits + rerunning this script are the whole dev loop.
#
# The window opens a multi-root workspace — the app FIRST, then the `day` checkout — because the
# loop needs all three of these at once:
#
#   * the app supplies the Day.toml the extension's sidebar, tasks, and debug configs act on;
#   * `day/` is open for editing beside it, so a fix to a core/toolkit/piece/part crate and the
#     app that exercises it are one window apart;
#   * with `day/` among the workspace folders the extension's CLI resolver runs
#     `cargo run -q -p day-cli` from that checkout in PREFERENCE to any installed `day`
#     (src/cli.ts), so the editor drives the same CLI this script does.
#
# Both sides therefore ignore whatever `day` is on PATH. That binary is whatever was released or
# installed last, and a CLI a version behind the crates in `day/` writes a [patch] table an older
# `day patch` understood and reports targets and Day.toml fields that predate them — so this
# script builds `day-cli` from the checkout and invokes it by path.
#
# `day patch` then points the app's cargo resolution at that same checkout, so every crate in
# `day/` — core, toolkits, pieces, parts — is a path dependency rather than the published git
# one. An edit there lands in the very next build the extension's Build/Run/Restart commands
# start, with no republish and no version bump.

set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLINGS="$(cd "$EXT_DIR/.." && pwd)"
DAY_REPO="$SIBLINGS/day"
# Generated, machine-local, and absolute-pathed: it belongs in the ignored build dir, not in git.
WORKSPACE="$EXT_DIR/build/day-dev.code-workspace"

usage() {
  echo "usage: scripts/dev.sh [path-to-day-project]" >&2
  # Naming the projects that ARE here beats naming one in the default: this list follows whatever
  # the developer has checked out, and stays right when it changes.
  local d found=""
  for d in "$SIBLINGS"/*/; do
    if [ -f "${d}Day.toml" ]; then
      [ -n "$found" ] || echo "       Day projects beside this repository:" >&2
      found=1
      echo "         ${d%/}" >&2
    fi
  done
}

# The day CLI's own rule (`--project` defaults to the nearest ancestor with a Day.toml). Matching it
# is what lets this script be run from inside any app, and what keeps a specific app's name out of
# the source.
find_project_upward() {
  local dir="$1"
  while :; do
    if [ -f "$dir/Day.toml" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    local parent
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && return 1
    dir="$parent"
  done
}

if ! command -v code >/dev/null 2>&1; then
  echo "error: the 'code' CLI is not on PATH (VS Code → ⇧⌘P → 'Shell Command: Install…')" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  PROJECT="$1"
  if [ ! -f "$PROJECT/Day.toml" ]; then
    echo "error: $PROJECT is not a Day project (no Day.toml)" >&2
    usage
    exit 2
  fi
elif ! PROJECT="$(find_project_upward "$PWD")"; then
  echo "error: no Day project given, and no Day.toml in $PWD or any parent" >&2
  usage
  exit 2
fi
PROJECT="$(cd "$PROJECT" && pwd)"

# A day checkout, not just any folder called `day`: the patch table and the CLI fallback both
# address crates inside it, and pointing either at the wrong tree fails far from here.
if [ ! -f "$DAY_REPO/crates/day-cli/Cargo.toml" ]; then
  echo "error: no day checkout at $DAY_REPO (expected crates/day-cli/Cargo.toml)" >&2
  echo "       clone daybrite/day beside this repository" >&2
  exit 2
fi
DAY_REPO="$(cd "$DAY_REPO" && pwd)"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is not on PATH" >&2
  echo "       install Rust from https://rustup.rs — the day CLI is built from the checkout" >&2
  echo "       at $DAY_REPO, never taken from PATH" >&2
  exit 1
fi

# Braced, like the pointing line below: bash reads the trailing multi-byte ellipsis as part of the
# variable name otherwise, and `set -u` then aborts the script on a name that never existed.
echo "▸ building day-cli from ${DAY_REPO}…"
# Unconditional, and never `day` from PATH: "if needed" is cargo's judgement to make, so a fresh
# tree costs one no-op invocation and a stale one is rebuilt before the patch table is written with
# it. Debug, because this is the build TOOL, not the thing under test. Run from the day repo so
# cargo reads THAT workspace's config, not the target project's — and it is the same target dir the
# extension's own `cargo run -q -p day-cli` uses, so this warms the editor's first command too.
(cd "$DAY_REPO" && cargo build -p day-cli)

DAY_BIN="${CARGO_TARGET_DIR:-$DAY_REPO/target}/debug/day"
if [ ! -x "$DAY_BIN" ]; then
  echo "error: cargo reported success but $DAY_BIN is missing" >&2
  echo "       (CARGO_TARGET_DIR, or a build.target-dir config pointing elsewhere?)" >&2
  exit 1
fi
echo "▸ using $DAY_BIN"

echo "▸ building the extension from source ($EXT_DIR)…"
(cd "$EXT_DIR" && npm run --silent bundle)

# Braced so bash does not read the trailing multi-byte ellipsis as part of the name.
echo "▸ pointing $(basename "$PROJECT") at ${DAY_REPO}…"
# Rewrites the app's gitignored .cargo/config.toml and verifies no day crate still resolves from
# git — a crate missing from the table silently builds from the git cache, and the edit under
# test then never reaches the app.
"$DAY_BIN" patch --local "$DAY_REPO" --project "$PROJECT"

mkdir -p "$(dirname "$WORKSPACE")"
# `day.cliPath` pins the window to the binary built above. The extension would find the checkout's
# CLI on its own (src/cli.ts), but this leaves nothing to resolve: no PATH lookup, no cargo needed
# in the extension host's environment — which is not this shell's when `code` hands the window to an
# already-running VS Code, and is where "the day CLI isn't installed" came from with a perfectly
# good CLI sitting in the checkout. Workspace-scoped, in a generated machine-local file.
cat > "$WORKSPACE" <<JSON
{
  "folders": [
    { "path": "$PROJECT" },
    { "path": "$DAY_REPO" }
  ],
  "settings": {
    "day.cliPath": "$DAY_BIN"
  }
}
JSON

echo "▸ launching VS Code (Extension Development Host) on $PROJECT + $DAY_REPO"
exec code --new-window --extensionDevelopmentPath="$EXT_DIR" "$WORKSPACE"
