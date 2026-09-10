#!/usr/bin/env bash
# Launch VS Code with the LOCAL source build of the Day extension, on a workspace holding BOTH
# repositories the extension's dev loop needs.
#
#   scripts/dev.sh [path ...]
#
# An argument is either a Day app — any conventional Day project, nothing here is specific to one —
# or any other folder worth having open beside it, typically a crate the app is being developed
# against (an external piece or part repository, a fork of a dependency). Both kinds go into the
# window; a Day.toml is what tells them apart. The projects that have one are patched at `day/`,
# and at each named crate they depend on, so an edit to a piece opened here reaches the app in the
# same window. The crate's own resolution is left as it is: it is open for editing, not under
# test, and `day patch` has nothing to say about a project with no Day.toml.
#
# With no argument it is the nearest ancestor of the CURRENT DIRECTORY holding a
# Day.toml, the same rule `day --project` follows, so
#
#   cd ~/apps/MyApp && ~/src/day-vscode/scripts/dev.sh
#
# opens that app. With no argument AND no Day project to find — a fresh clone, before there is
# anything to open — it installs this repository's dependencies and opens a window on the
# extension's welcome page instead of refusing to start. That window has no app in it, so the Day
# sidebar shows its empty state, and the way on from there is the same `Create a Day Project`
# button a first-time user sees.
#
# Passing several opens them in one window, each Day project patched at `day/`:
#
#   cd ~/src/daybrite && day-vscode/scripts/dev.sh Day-Sketch Day-Showcase
#   cd ~/src/daybrite && day-vscode/scripts/dev.sh Day-Showcase day-piece-charts
#
# which is how to exercise the extension against more than one project at a time. Each app appears
# in the sidebar with its own targets, mode, locale and dayscript; the focused one follows the file
# being edited, and `Day: Run All Projects` launches every ticked target across all of them. The
# second form adds a crate to the same window and points Day-Showcase at it, so editing the piece
# and running the app that draws it are one window apart — the sidebar has nothing to say about the
# crate itself, and it is the app beside it that exercises the edit.
#
# The window is an Extension Development Host: the extension running there is built fresh from THIS
# working tree (superseding any installed day-vscode in that window), so source edits + rerunning
# this script are the whole dev loop.
#
# The window opens a multi-root workspace — the app(s) FIRST, then the `day` checkout — because the
# loop needs all three of these at once:
#
#   * the app supplies the Day.toml the extension's sidebar, tasks, and debug configs act on;
#   * `day/` is open for editing beside it, so a fix to a core/toolkit/piece/part crate and the
#     app that exercises it are one window apart;
#   * the generated workspace sets `day.cliSource` to that checkout, so every CLI invocation the
#     editor makes is `cargo run` against it (src/cli.ts) — an edit to day-cli reaches the next
#     build without rerunning this script, and no installed `day` is consulted.
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
  echo "usage: scripts/dev.sh [path ...]" >&2
  echo "       each path is a Day project (patched at the day checkout, and at any crate" >&2
  echo "       below it depends on) or a crate to open beside it" >&2
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

# The Day projects, and the folders that are merely open beside them. Two lists rather than one
# with a flag: everything downstream wants one or the other — `day patch` runs over the first, the
# window opens both.
PROJECTS=()
FOLDERS=()
# Named twice in one invocation, or named once as `.` and once by path, would put the same folder in
# the workspace twice — VS Code shows both, and the second is indistinguishable from the first.
add_folder() {
  local resolved p
  resolved="$(cd "$1" && pwd)"
  for p in ${PROJECTS+"${PROJECTS[@]}"} ${FOLDERS+"${FOLDERS[@]}"}; do
    [ "$p" = "$resolved" ] && return 0
  done
  # A Day.toml is the whole test, and the same one `day --project` applies: with one, the project
  # is patched and the extension's sidebar has targets to show for it; without, it is a folder.
  if [ -f "$resolved/Day.toml" ]; then
    PROJECTS+=("$resolved")
  else
    FOLDERS+=("$resolved")
  fi
}

# Nothing to open is a legitimate starting point rather than an error: it is what a fresh clone
# looks like, and the welcome page exists for exactly that moment.
WELCOME=0
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    # The only thing still worth refusing is a path that is not there. A folder with no Day.toml is
    # a legitimate argument now, so the sole remaining mistake this can catch is a typo — which is
    # worth catching, because the alternative is a window silently missing what was asked for.
    if [ ! -d "$arg" ]; then
      echo "error: $arg is not a directory" >&2
      usage
      exit 2
    fi
    add_folder "$arg"
  done
elif PROJECT="$(find_project_upward "$PWD")"; then
  add_folder "$PROJECT"
else
  WELCOME=1
  echo "▸ no Day project given, and none above $PWD — opening the welcome page"
fi

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

# A fresh clone has no node_modules, and `npm run bundle` fails there with esbuild "not found" —
# which reads like a broken repository rather than a missing install step. `npm ci` when the
# lockfile is there (reproducible, and what CI runs), `npm install` when it is not.
if [ ! -d "$EXT_DIR/node_modules" ]; then
  echo "▸ installing extension dependencies (first run)…"
  if [ -f "$EXT_DIR/package-lock.json" ]; then
    (cd "$EXT_DIR" && npm ci)
  else
    (cd "$EXT_DIR" && npm install)
  fi
fi

echo "▸ building the extension from source ($EXT_DIR)…"
(cd "$EXT_DIR" && npm run --silent bundle)

# Every project gets its own patch table: they are separate cargo workspaces, and one left
# unpatched would quietly build the published day crates from the git cache while its neighbour
# built the checkout — the same window, two different frameworks under test.
for project in ${PROJECTS+"${PROJECTS[@]}"}; do
  # Braced so bash does not read the trailing multi-byte ellipsis as part of the name.
  echo "▸ pointing $(basename "$project") at ${DAY_REPO}…"
  # The day checkout for every project, and each folder named beside it for the projects that
  # actually depend on it — an external piece or part repository is a patch source in its own
  # right (`day patch --local` is repeatable and documents exactly that), so a piece opened here
  # for editing is built from this checkout rather than fetched from git.
  #
  # Which projects those are is a question `day patch` already answers, so it is asked rather than
  # reimplemented: a source the project has no dependency from is refused outright ("nothing to
  # patch there"), and a refusal writes nothing. So the list grows one folder at a time, keeping
  # whatever takes. The probes are silent because their failures are expected and uninteresting —
  # a window may well hold a crate that this particular app has never heard of. The run that
  # matters is the last one, with the sources that survived, and it reports for itself.
  SOURCES=(--local "$DAY_REPO")
  for folder in ${FOLDERS+"${FOLDERS[@]}"}; do
    if PROBE="$("$DAY_BIN" patch "${SOURCES[@]}" --local "$folder" --project "$project" 2>&1)"; then
      SOURCES+=(--local "$folder")
      echo "  + and at $(basename "$folder")"
    elif ! printf '%s' "$PROBE" | grep -q "no dependencies from"; then
      # Declined for a reason other than "this project doesn't use it" — the wrong branch, a
      # renamed crate, a checkout that is not what it looks like. The source is left out either
      # way, but leaving it out QUIETLY is how an edit under test never reaches the app, so this
      # one is repeated rather than swallowed with the expected ones.
      echo "  ! $(basename "$folder") could not be patched in, and is not in the table:" >&2
      printf '%s\n' "$PROBE" >&2
    fi
  done
  # Rewrites the app's gitignored .cargo/config.toml and verifies no day crate still resolves from
  # git — a crate missing from the table silently builds from the git cache, and the edit under
  # test then never reaches the app.
  "$DAY_BIN" patch "${SOURCES[@]}" --project "$project"
done

# Said out loud rather than passed over in silence: a folder in the window that no `day patch` line
# mentioned is easy to mistake for one that was wired into the projects beside it.
for folder in ${FOLDERS+"${FOLDERS[@]}"}; do
  echo "▸ opening $(basename "$folder") beside them — its own cargo resolution is left as it is"
done

# The window's folder list, in the order VS Code will show it: the Day projects first (the sidebar
# and the tasks act on those), then whatever else was named, then `day` last.
OPENED=(${PROJECTS+"${PROJECTS[@]}"} ${FOLDERS+"${FOLDERS[@]}"})

mkdir -p "$(dirname "$WORKSPACE")"
# Built line by line rather than as one here-document because the folder list is variable length:
# the folders named on the command line, then `day` last.
#
# `day.cliSource` rather than `day.cliPath` pointing at the binary built above: the window then runs
# the CLI as `cargo run --manifest-path <day>/Cargo.toml -q -p day-cli --`, so an edit to day-cli is
# compiled into the very next build, launch or project scan without rerunning this script. The
# binary is still built first — it is what `day patch` above runs, and it leaves the cargo cache
# warm, so the editor's first invocation is a freshness check rather than a cold compile.
#
# The cost of that convenience is a dependency on `cargo` being on the PATH the editor inherits,
# which is NOT this shell's when `code` hands the window to an already-running VS Code — the source
# of "the day CLI isn't installed" with a perfectly good CLI sitting in the checkout. src/cli.ts
# checks for cargo up front and falls back to that same built binary rather than failing every
# call. Workspace-scoped, in a generated machine-local file.
{
  echo '{'
  echo '  "folders": ['
  for folder in ${OPENED+"${OPENED[@]}"}; do
    echo "    { \"path\": \"$folder\" },"
  done
  echo "    { \"path\": \"$DAY_REPO\" }"
  echo '  ],'
  echo '  "settings": {'
  if [ "$WELCOME" = 1 ]; then
    echo "    \"day.cliSource\": \"$DAY_REPO\","
  else
    echo "    \"day.cliSource\": \"$DAY_REPO\""
  fi
  # With no app to open, land on the extension's own welcome page.
  #
  # `code` has no flag that runs a command at startup, and it hands a new window to an
  # already-running VS Code — which does not inherit this shell's environment — so a setting in
  # the generated workspace is the only channel that works every time. The extension reads
  # `day.showWalkthroughOnStartup` when it activates and opens the walkthrough.
  #
  # `workbench.startupEditor` is the backstop for the case where it does not activate: the
  # extension activates on a Day.toml anywhere in the workspace, which the day checkout satisfies
  # only because it carries the scaffold TEMPLATE's Day.toml. That is incidental, so the Welcome
  # page — which lists the walkthrough whether or not anything activated — is what catches it.
  if [ "$WELCOME" = 1 ]; then
    echo '    "day.showWalkthroughOnStartup": true,'
    echo '    "workbench.startupEditor": "welcomePage"'
  fi
  echo '  }'
  echo '}'
} > "$WORKSPACE"

if [ "$WELCOME" = 1 ]; then
  echo "▸ launching VS Code (Extension Development Host) on $DAY_REPO — welcome page"
else
  echo "▸ launching VS Code (Extension Development Host) on ${OPENED[*]} + $DAY_REPO"
fi
exec code --new-window --extensionDevelopmentPath="$EXT_DIR" "$WORKSPACE"
