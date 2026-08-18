<#
.SYNOPSIS
    Launch VS Code with the LOCAL source build of the Day extension, on a workspace holding BOTH
    repositories the extension's dev loop needs. The Windows counterpart of scripts/dev.sh.

.DESCRIPTION
    With no argument the app is the sibling `Day-Showcase` checkout. The window is an Extension
    Development Host: the extension running there is built fresh from THIS working tree
    (superseding any installed day-vscode in that window), so source edits + rerunning this script
    are the whole dev loop.

    The window opens a multi-root workspace - the app FIRST, then the `day` checkout - because the
    loop needs all three of these at once:

      * the app supplies the Day.toml the extension's sidebar, tasks, and debug configs act on;
      * `day/` is open for editing beside it, so a fix to a core/toolkit/piece/part crate and the
        app that exercises it are one window apart;
      * with `day/` among the workspace folders the extension's CLI resolver can fall back to
        `cargo run -p day-cli` from that checkout when no `day` is on PATH (src/cli.ts).

    `day patch` then points the app's cargo resolution at that same checkout, so every crate in
    `day/` - core, toolkits, pieces, parts - is a path dependency rather than the published git
    one. An edit there lands in the very next build the extension's Build/Run/Restart commands
    start, with no republish and no version bump.

    On this host that means the windows-* targets: `day build`/`day launch` drive MSVC and the
    Windows SDK directly, and `day doctor` reports what is missing. Nothing here is macOS-specific.

.PARAMETER Project
    Path to the Day project to open. Defaults to the sibling `Day-Showcase` checkout.

.EXAMPLE
    .\scripts\dev.ps1

.EXAMPLE
    .\scripts\dev.ps1 ..\Day-Games

.NOTES
    If PowerShell refuses to run this file, the execution policy is blocking unsigned local
    scripts. Start it as:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Project
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
if (-not $Project) {
    $Project = Join-Path $Siblings 'Day-Showcase'
}
# Generated, machine-local, and absolute-pathed: it belongs in the ignored build dir, not in git.
$Workspace = Join-Path (Join-Path $ExtDir 'build') 'day-dev.code-workspace'

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Fail @"
error: the 'code' CLI is not on PATH
       Re-run the VS Code installer and tick "Add to PATH", or use Ctrl+Shift+P ->
       'Shell Command: Install ''code'' command in PATH'
"@
}

if (-not (Test-Path (Join-Path $Project 'Day.toml'))) {
    Fail "error: $Project is not a Day project (no Day.toml)`nusage: scripts\dev.ps1 [path-to-day-project]" 2
}
$Project = (Resolve-Path $Project).Path

# A day checkout, not just any folder called `day`: the patch table and the CLI fallback both
# address crates inside it, and pointing either at the wrong tree fails far from here.
$DayCliManifest = Join-Path (Join-Path (Join-Path $DayRepo 'crates') 'day-cli') 'Cargo.toml'
if (-not (Test-Path $DayCliManifest)) {
    Fail "error: no day checkout at $DayRepo (expected crates\day-cli\Cargo.toml)`n       clone daybrite/day beside this repository" 2
}
$DayRepo = (Resolve-Path $DayRepo).Path

# The installed CLI when there is one, else the checkout's own - the same order the extension
# resolves in, so this script never needs a `day` on PATH that the editor would not have either.
$DayOnPath = [bool](Get-Command day -ErrorAction SilentlyContinue)
if (-not $DayOnPath) {
    Step "no 'day' on PATH - using cargo run -p day-cli from $DayRepo"
}

function Invoke-Day {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DayArgs)
    if ($DayOnPath) {
        & day @DayArgs
    }
    else {
        # cwd is the day repo so cargo reads THAT workspace's config, not the target project's.
        Push-Location $DayRepo
        try { & cargo run -q -p day-cli -- @DayArgs } finally { Pop-Location }
    }
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

Step "pointing $(Split-Path $Project -Leaf) at $DayRepo"
# Rewrites the app's gitignored .cargo/config.toml and verifies no day crate still resolves from
# git - a crate missing from the table silently builds from the git cache, and the edit under
# test then never reaches the app.
Invoke-Day patch --local $DayRepo --project $Project

New-Item -ItemType Directory -Force -Path (Split-Path $Workspace -Parent) | Out-Null
# Built as an object and serialized, never interpolated into a here-string: a Windows path is full
# of backslashes, and "C:\src\day" is not valid JSON. ConvertTo-Json escapes them.
$workspaceJson = [ordered]@{
    folders  = @(
        [ordered]@{ path = $Project },
        [ordered]@{ path = $DayRepo }
    )
    settings = @{}
} | ConvertTo-Json -Depth 4
# UTF-8 *without* a BOM - Set-Content -Encoding UTF8 writes one on Windows PowerShell 5.1, and a
# BOM ahead of the opening brace makes the workspace file fail to parse.
[System.IO.File]::WriteAllText($Workspace, $workspaceJson, [System.Text.UTF8Encoding]::new($false))

Step "launching VS Code (Extension Development Host) on $Project + $DayRepo"
& code --new-window "--extensionDevelopmentPath=$ExtDir" $Workspace
exit $LASTEXITCODE
