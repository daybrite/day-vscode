<#
.SYNOPSIS
    Launch VS Code with the LOCAL source build of the Day extension, on a workspace holding BOTH
    repositories the extension's dev loop needs. The Windows counterpart of scripts/dev.sh.

.DESCRIPTION
    The arguments are the Day apps to open beside `day/` - any conventional Day project, nothing
    here is specific to one. With no argument it is the nearest ancestor of the CURRENT DIRECTORY
    holding a Day.toml, the same rule `day --project` follows, so

        cd ~\apps\MyApp; ~\src\day-vscode\scripts\dev.ps1

    opens that app. Passing several opens them in one window, each patched at `day/`:

        cd ~\src\daybrite; day-vscode\scripts\dev.ps1 Day-Sketch Day-Showcase

    which is how to exercise the extension against more than one project at a time. Each app
    appears in the sidebar with its own targets, mode, locale and dayscript; the focused one
    follows the file being edited, and `Day: Run All Projects` launches every ticked target across
    all of them.

    The window is an Extension Development Host: the extension running there is built fresh from
    THIS working tree (superseding any installed day-vscode in that window), so source edits +
    rerunning this script are the whole dev loop.

    The window opens a multi-root workspace - the app(s) FIRST, then the `day` checkout - because
    the loop needs all three of these at once:

      * the app supplies the Day.toml the extension's sidebar, tasks, and debug configs act on;
      * `day/` is open for editing beside it, so a fix to a core/toolkit/piece/part crate and the
        app that exercises it are one window apart;
      * the generated workspace sets `day.cliSource` to that checkout, so every CLI invocation
        the editor makes is `cargo run` against it (src/cli.ts) - an edit to day-cli reaches the
        next build without rerunning this script, and no installed `day` is consulted.

    Both sides therefore ignore whatever `day` is on PATH. That binary is whatever was released
    or installed last, and a CLI a version behind the crates in `day/` writes a [patch] table an
    older `day patch` understood and reports targets and Day.toml fields that predate them - so
    this script builds `day-cli` from the checkout and invokes it by path.

    `day patch` then points the app's cargo resolution at that same checkout, so every crate in
    `day/` - core, toolkits, pieces, parts - is a path dependency rather than the published git
    one. An edit there lands in the very next build the extension's Build/Run/Restart commands
    start, with no republish and no version bump.

    On this host that means the windows-* targets: `day build`/`day launch` drive MSVC and the
    Windows SDK directly, and `day doctor` reports what is missing. Nothing here is macOS-specific.

.PARAMETER Project
    Paths to the Day projects to open, in the order they should appear in the workspace. Defaults
    to the nearest ancestor of the current directory holding a Day.toml.

.EXAMPLE
    .\scripts\dev.ps1 ..\Day-Showcase

.EXAMPLE
    .\scripts\dev.ps1 ..\Day-Sketch ..\Day-Showcase

.EXAMPLE
    cd ..\Day-Games; ..\day-vscode\scripts\dev.ps1

.NOTES
    If PowerShell refuses to run this file, the execution policy is blocking unsigned local
    scripts. Start it as:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
[CmdletBinding()]
param(
    # Several projects open in one window, each patched at the day checkout; none means the nearest
    # ancestor of the current directory holding a Day.toml.
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Project
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# `exit` rather than `throw`: this is a launcher, and a PowerShell stack trace would bury the one
# line that says what to fix.
function Fail {
    param([string]$Message, [int]$Code = 1)
    # Split on either ending: this file may be checked out with CRLF, which would otherwise leave a
    # stray carriage return on every line of a multi-line message.
    foreach ($line in $Message -split "`r?`n") {
        [Console]::Error.WriteLine($line)
    }
    exit $Code
}

# ASCII only, in the markers and throughout this file. dev.sh prints a Unicode marker, but a Windows
# console under a legacy code page renders multi-byte output as mojibake, and Windows PowerShell 5.1
# decodes a BOM-less script in the active ANSI code page rather than UTF-8. Staying ASCII sidesteps
# both without needing a byte-order mark.
function Step {
    # Write-Host is the right call here and PSScriptAnalyzer's blanket rule is not: these lines are
    # progress for a human at a terminal, and Write-Output would put them in the pipeline.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param([string]$Message)
    Write-Host "> $Message"
}

$ExtDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Siblings = (Resolve-Path (Join-Path $ExtDir '..')).Path
$DayRepo = Join-Path $Siblings 'day'
# Generated, machine-local, and absolute-pathed: it belongs in the ignored build dir, not in git.
$Workspace = Join-Path (Join-Path $ExtDir 'build') 'day-dev.code-workspace'

function Get-Usage {
    $lines = @('usage: scripts\dev.ps1 [path-to-day-project ...]')
    # Naming the projects that ARE here beats naming one in the default: this list follows whatever
    # the developer has checked out, and stays right when it changes.
    $found = Get-ChildItem -Path $Siblings -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'Day.toml') }
    if ($found) {
        $lines += '       Day projects beside this repository:'
        $lines += ($found | ForEach-Object { "         $($_.FullName)" })
    }
    return ($lines -join "`n")
}

# The day CLI's own rule (`--project` defaults to the nearest ancestor with a Day.toml). Matching it
# is what lets this script be run from inside any app, and what keeps a specific app's name out of
# the source.
function Find-DayProjectUpward {
    param([string]$Start)
    $dir = $Start
    while ($true) {
        if (Test-Path (Join-Path $dir 'Day.toml')) { return $dir }
        $parent = Split-Path $dir -Parent
        if (-not $parent -or $parent -eq $dir) { return $null }
        $dir = $parent
    }
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Fail @"
error: the 'code' CLI is not on PATH
       Re-run the VS Code installer and tick "Add to PATH", or use Ctrl+Shift+P ->
       'Shell Command: Install ''code'' command in PATH'
"@
}

$Projects = [System.Collections.Generic.List[string]]::new()
if ($Project) {
    foreach ($candidate in $Project) {
        if (-not (Test-Path (Join-Path $candidate 'Day.toml'))) {
            Fail "error: $candidate is not a Day project (no Day.toml)`n$(Get-Usage)" 2
        }
        # Resolved before the duplicate check: the same folder named twice, or named once as `.` and
        # once by path, would otherwise appear twice in the workspace.
        $resolved = (Resolve-Path $candidate).Path
        if (-not $Projects.Contains($resolved)) { $Projects.Add($resolved) }
    }
}
else {
    # ProviderPath, not Get-Location: a PowerShell location can sit on a non-filesystem provider,
    # and only the filesystem path can be walked upward.
    $here = $PWD.ProviderPath
    $found = Find-DayProjectUpward $here
    if (-not $found) {
        Fail "error: no Day project given, and no Day.toml in $here or any parent`n$(Get-Usage)" 2
    }
    $Projects.Add((Resolve-Path $found).Path)
}

# A day checkout, not just any folder called `day`: the patch table and the CLI fallback both
# address crates inside it, and pointing either at the wrong tree fails far from here.
$DayCliManifest = Join-Path (Join-Path (Join-Path $DayRepo 'crates') 'day-cli') 'Cargo.toml'
if (-not (Test-Path $DayCliManifest)) {
    Fail "error: no day checkout at $DayRepo (expected crates\day-cli\Cargo.toml)`n       clone daybrite/day beside this repository" 2
}
$DayRepo = (Resolve-Path $DayRepo).Path

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Fail @"
error: cargo is not on PATH
       install Rust from https://rustup.rs - the day CLI is built from the checkout at
       $DayRepo, never taken from PATH
"@
}

Step "building day-cli from $DayRepo"
# Unconditional, and never `day` from PATH: "if needed" is cargo's judgement to make, so a fresh
# tree costs one no-op invocation and a stale one is rebuilt before the patch table is written
# with it. Debug, because this is the build TOOL, not the thing under test. cwd is the day repo so
# cargo reads THAT workspace's config, not the target project's - and it is the same target dir
# the extension's own `cargo run -q -p day-cli` uses, so this warms the editor's first command too.
Push-Location $DayRepo
try {
    & cargo build -p day-cli
    if ($LASTEXITCODE -ne 0) {
        Fail "error: cargo build -p day-cli failed in $DayRepo (exit $LASTEXITCODE)" $LASTEXITCODE
    }
}
finally { Pop-Location }

$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $DayRepo 'target' }
$DayExe = Join-Path (Join-Path $TargetDir 'debug') 'day.exe'
if (-not (Test-Path $DayExe)) {
    Fail "error: cargo reported success but $DayExe is missing`n       (CARGO_TARGET_DIR, or a build.target-dir config pointing elsewhere?)"
}
Step "using $DayExe"

function Invoke-Day {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DayArgs)
    & $DayExe @DayArgs
    # $ErrorActionPreference does not apply to native commands: without this check a failed patch
    # would be followed by a cheerfully launched editor built against the wrong crates.
    if ($LASTEXITCODE -ne 0) {
        Fail "error: day $($DayArgs -join ' ') failed (exit $LASTEXITCODE)" $LASTEXITCODE
    }
}

Step "building the extension from source ($ExtDir)"
Push-Location $ExtDir
try {
    & npm run --silent bundle
    if ($LASTEXITCODE -ne 0) { Fail "error: npm run bundle failed (exit $LASTEXITCODE)" $LASTEXITCODE }
}
finally { Pop-Location }

# Every project gets its own patch table: they are separate cargo workspaces, and one left
# unpatched would quietly build the published day crates from the git cache while its neighbour
# built the checkout - the same window, two different frameworks under test.
foreach ($p in $Projects) {
    Step "pointing $(Split-Path $p -Leaf) at $DayRepo"
    # Rewrites the app's gitignored .cargo/config.toml and verifies no day crate still resolves from
    # git - a crate missing from the table silently builds from the git cache, and the edit under
    # test then never reaches the app.
    Invoke-Day patch --local $DayRepo --project $p
}

New-Item -ItemType Directory -Force -Path (Split-Path $Workspace -Parent) | Out-Null
# Built as an object and serialized, never interpolated into a here-string: a Windows path is full
# of backslashes, and "C:\src\day" is not valid JSON. ConvertTo-Json escapes them.
# `day.cliPath` pins the window to the binary built above. The extension would find the checkout's
# CLI on its own (src/cli.ts), but this leaves nothing to resolve: no PATH lookup, no cargo needed
# in the extension host's environment - which is not this shell's when `code` hands the window to an
# already-running VS Code, and is where "the day CLI isn't installed" came from with a perfectly
# good CLI sitting in the checkout. Workspace-scoped, in a generated machine-local file.
# Appended one at a time to an array declared as such. `$a + $b` on two [ordered] maps MERGES them
# (and throws on the duplicate `path` key) rather than making a two-element list, so the pipeline
# spelling of this is a trap. The day checkout goes last, after the projects.
$folderList = @()
foreach ($p in $Projects) { $folderList += [ordered]@{ path = $p } }
$folderList += [ordered]@{ path = $DayRepo }
# `day.cliSource` rather than the binary path: the window runs the CLI through `cargo run` against
# the checkout, so a day-cli edit is compiled into the next build without rerunning this script.
# The binary above is still what `day patch` uses, and it leaves the cargo cache warm.
$workspaceJson = [ordered]@{
    folders  = $folderList
    settings = [ordered]@{ 'day.cliSource' = $DayRepo }
} | ConvertTo-Json -Depth 4
# UTF-8 *without* a BOM - Set-Content -Encoding UTF8 writes one on Windows PowerShell 5.1, and a
# BOM ahead of the opening brace makes the workspace file fail to parse.
[System.IO.File]::WriteAllText($Workspace, $workspaceJson, [System.Text.UTF8Encoding]::new($false))

Step "launching VS Code (Extension Development Host) on $($Projects -join ' ') + $DayRepo"
& code --new-window "--extensionDevelopmentPath=$ExtDir" $Workspace
exit $LASTEXITCODE
