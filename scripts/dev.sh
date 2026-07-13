#!/usr/bin/env bash
# Launch VS Code with the LOCAL source build of the Day extension, opened on a Day project.
#
#   scripts/dev.sh [path-to-day-project]
#
# With no argument it opens the Day Showcase app from the sibling `day` checkout. The window is
# an Extension Development Host: the extension running there is built fresh from THIS working
# tree (superseding any installed day-vscode in that window), so source edits + rerunning this
# script are the whole dev loop.

set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_PROJECT="$EXT_DIR/../day/apps/showcase"
PROJECT="${1:-$DEFAULT_PROJECT}"

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

echo "▸ building the extension from source ($EXT_DIR)…"
(cd "$EXT_DIR" && npm run --silent bundle)

echo "▸ launching VS Code (Extension Development Host) on $PROJECT"
exec code --new-window --extensionDevelopmentPath="$EXT_DIR" "$PROJECT"
