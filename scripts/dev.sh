#!/usr/bin/env bash
# Launch VS Code with the LOCAL source build of the Day extension, on a workspace holding BOTH
# repositories the extension's dev loop needs.
#
#   scripts/dev.sh [path-to-day-project]
#
# With no argument the app is the sibling `Day-Showcase` checkout. The window is an Extension
# Development Host: the extension running there is built fresh from THIS working tree
# (superseding any installed day-vscode in that window), so source edits + rerunning this script
# are the whole dev loop.
#
# The window opens a multi-root workspace — the app FIRST, then the `day` checkout — because the
# loop needs all three of these at once:
#
#   * the app supplies the Day.toml the extension's sidebar, tasks, and debug configs act on;
#   * `day/` is open for editing beside it, so a fix to a core/toolkit/piece/part crate and the
#     app that exercises it are one window apart;
#   * with `day/` among the workspace folders the extension's CLI resolver can fall back to
#     `cargo run -p day-cli` from that checkout when no `day` is on PATH (src/cli.ts).
#
# `day patch` then points the app's cargo resolution at that same checkout, so every crate in
# `day/` — core, toolkits, pieces, parts — is a path dependency rather than the published git
# one. An edit there lands in the very next build the extension's Build/Run/Restart commands
# start, with no republish and no version bump.

set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLINGS="$(cd "$EXT_DIR/.." && pwd)"
DAY_REPO="$SIBLINGS/day"
PROJECT="${1:-$SIBLINGS/Day-Showcase}"
# Generated, machine-local, and absolute-pathed: it belongs in the ignored build dir, not in git.
WORKSPACE="$EXT_DIR/build/day-dev.code-workspace"

if ! command -v code >/dev/null 2>&1; then
  echo "error: the 'code' CLI is not on PATH (VS Code → ⇧⌘P → 'Shell Command: Install…')" >&2
  exit 1
fi

if [ ! -f "$PROJECT/Day.toml" ]; then
  echo "error: $PROJECT is not a Day project (no Day.toml)" >&2
  echo "usage: scripts/dev.sh [path-to-day-project]" >&2
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

# The installed CLI when there is one, else the checkout's own — the same order the extension
# resolves in, so this script never needs a `day` on PATH that the editor would not have either.
if command -v day >/dev/null 2>&1; then
  day() { command day "$@"; }
else
  echo "▸ no 'day' on PATH — using cargo run -p day-cli from $DAY_REPO"
  day() { (cd "$DAY_REPO" && cargo run -q -p day-cli -- "$@"); }
fi

echo "▸ building the extension from source ($EXT_DIR)…"
(cd "$EXT_DIR" && npm run --silent bundle)

# Braced so bash does not read the trailing multi-byte ellipsis as part of the name.
echo "▸ pointing $(basename "$PROJECT") at ${DAY_REPO}…"
# Rewrites the app's gitignored .cargo/config.toml and verifies no day crate still resolves from
# git — a crate missing from the table silently builds from the git cache, and the edit under
# test then never reaches the app.
day patch --local "$DAY_REPO" --project "$PROJECT"

mkdir -p "$(dirname "$WORKSPACE")"
cat > "$WORKSPACE" <<JSON
{
  "folders": [
    { "path": "$PROJECT" },
    { "path": "$DAY_REPO" }
  ],
  "settings": {}
}
JSON

echo "▸ launching VS Code (Extension Development Host) on $PROJECT + $DAY_REPO"
exec code --new-window --extensionDevelopmentPath="$EXT_DIR" "$WORKSPACE"
