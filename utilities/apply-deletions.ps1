<#
.SYNOPSIS
Delete files on another system from a deleted-files.json list.

.DESCRIPTION
Reads the deletion list written by copy-uncommitted.ps1 and deletes those
relative paths under -Target. -Target is the other system's project root
(a local checkout, a mapped drive, or a UNC share).

Only files are removed. Paths must stay inside -Target: absolute paths,
drive letters, and ".." segments are skipped. Empty parent folders are
removed up to -Target unless -KeepEmptyDirs is set.

.EXAMPLE
.\utilities\apply-deletions.ps1 -List .cursor\copies\merged\deleted-files.json -Target D:\other-system\one-console -DryRun

.EXAMPLE
.\utilities\apply-deletions.ps1 -List .cursor\copies\merged -Target \\fileserver\share\one-console

.EXAMPLE
.\utilities\apply-deletions.ps1 -List .\deleted-files.txt -Target E:\app
#>
[CmdletBinding()]
param(
    [string] $List,
    [string] $Target,
    [switch] $DryRun,
    [switch] $KeepEmptyDirs,
    [switch] $Help
)

$ErrorActionPreference = "Stop"
if ($Help) {
    Get-Help -Name $PSCommandPath -Full | Out-Host
    exit 0
}
if ([string]::IsNullOrWhiteSpace($List) -or [string]::IsNullOrWhiteSpace($Target)) {
    throw "Pass -List and -Target. Use -Help for usage."
}

function To-Posix([string] $Path) {
    return ([string] $Path).Replace("\", "/")
}

function Get-SafeShipPath([string] $Path) {
    $n = (To-Posix $Path).Trim().TrimStart("/")
    if (-not $n) { return "" }
    if ([System.IO.Path]::IsPathRooted($n) -or $n -match "^[a-zA-Z]:") { return "" }
    $parts = $n.Split("/")
    foreach ($seg in $parts) {
        if (-not $seg -or $seg -eq "." -or $seg -eq "..") { return "" }
    }
    return ($parts -join "/")
}

function Read-DeletionPaths([string] $File) {
    $rawText = [System.IO.File]::ReadAllText($File)
    $trimmed = $rawText.TrimStart([char]0xFEFF, " ", "`t", "`r", "`n")
    $paths = New-Object System.Collections.Generic.List[string]
    if ($trimmed.StartsWith("{") -or $trimmed.StartsWith("[")) {
        $data = $trimmed | ConvertFrom-Json
        $raw = @()
        if ($data.entries) { $raw = @($data.entries) }
        elseif ($data.paths) { $raw = @($data.paths) }
        elseif ($data -is [System.Collections.IList]) { $raw = @($data) }
        foreach ($item in $raw) {
            if ($item -is [string]) { $paths.Add($item) }
            elseif ($item.path) { $paths.Add([string] $item.path) }
        }
        return @($paths)
    }
    foreach ($line in ($rawText -split "`r?`n")) {
        $line = $line.Trim()
        if (-not $line -or $line.StartsWith("#")) { continue }
        $path = ($line -split "`t")[0].Trim()
        if ($path) { $paths.Add($path) }
    }
    return @($paths)
}

function Resolve-ListFile([string] $InputPath) {
    if (-not (Test-Path -LiteralPath $InputPath)) {
        throw "Deletion list not found: $InputPath"
    }
    $item = Get-Item -LiteralPath $InputPath
    if (-not $item.PSIsContainer) { return $item.FullName }
    $candidate = Join-Path $item.FullName "deleted-files.json"
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "No deleted-files.json in $($item.FullName)"
    }
    return $candidate
}

function Test-ParentReparsePoint([string] $RootFull, [string] $Absolute) {
    $current = $RootFull
    $relative = $Absolute.Substring($RootFull.Length).TrimStart("\")
    $segments = @($relative.Split("\") | Where-Object { $_ })
    if ($segments.Count -lt 2) { return $false }
    for ($i = 0; $i -lt ($segments.Count - 1); $i++) {
        $current = Join-Path $current $segments[$i]
        if (-not (Test-Path -LiteralPath $current)) { return $false }
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $true }
    }
    return $false
}

function Resolve-UnderRoot([string] $RootFull, [string] $Relative) {
    $safe = Get-SafeShipPath $Relative
    if (-not $safe) { return $null }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $RootFull ($safe.Replace("/", "\"))))
    $prefix = $RootFull + "\"
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    if ($candidate.Equals($RootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    return @{ Relative = $safe; Absolute = $candidate }
}

function Remove-EmptyParents([string] $FileAbs, [string] $StopAbs) {
    $removed = 0
    $dir = Split-Path $FileAbs -Parent
    $stop = [System.IO.Path]::GetFullPath($StopAbs)
    while ($dir -and ([System.IO.Path]::GetFullPath($dir) -ne $stop)) {
        if (-not (Test-Path -LiteralPath $dir)) { break }
        $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
        if ($children.Count -gt 0) { break }
        Remove-Item -LiteralPath $dir -Force
        $removed++
        $dir = Split-Path $dir -Parent
    }
    return $removed
}

if (-not (Test-Path -LiteralPath $Target)) {
    throw "Target not found: $Target"
}
$targetItem = Get-Item -LiteralPath $Target
if (-not $targetItem.PSIsContainer) {
    throw "Target must be a directory: $Target"
}
$targetFull = [System.IO.Path]::GetFullPath($targetItem.FullName).TrimEnd("\")
if ($targetFull -match '^[A-Za-z]:$' -or $targetFull -eq "\" -or $targetFull -match '^\\\\[^\\]+\\[^\\]+$') {
    throw "Refusing to delete under a drive or share root ($targetFull). Pass the project folder on the other system."
}

$listFile = Resolve-ListFile $List
$requested = @(Read-DeletionPaths $listFile)
$seen = @{}
$deleted = New-Object System.Collections.Generic.List[string]
$missing = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]
$dirsRemoved = 0

foreach ($rawPath in $requested) {
    $resolved = Resolve-UnderRoot $targetFull $rawPath
    if (-not $resolved) {
        $skipped.Add([string] $rawPath)
        continue
    }
    if ($seen.ContainsKey($resolved.Relative)) { continue }
    $seen[$resolved.Relative] = $true
    $abs = $resolved.Absolute

    if (-not (Test-Path -LiteralPath $abs)) {
        $missing.Add($resolved.Relative)
        continue
    }
    if (Test-ParentReparsePoint $targetFull $abs) {
        $skipped.Add($resolved.Relative + " (link)")
        continue
    }
    $existing = Get-Item -LiteralPath $abs -Force
    if ($existing.PSIsContainer) {
        $skipped.Add($resolved.Relative + " (directory)")
        continue
    }

    if ($DryRun) {
        $deleted.Add($resolved.Relative)
        continue
    }

    try {
        Remove-Item -LiteralPath $abs -Force
        $deleted.Add($resolved.Relative)
        if (-not $KeepEmptyDirs) {
            $dirsRemoved += [int](Remove-EmptyParents $abs $targetFull)
        }
    }
    catch {
        $failed.Add("$($resolved.Relative): $($_.Exception.Message)")
    }
}

$lines = @(
    $(if ($DryRun) { "Dry run (no files deleted)." } else { "Delete complete." }),
    "List: $listFile",
    "Target: $targetFull",
    "Listed: $($requested.Count)",
    $(if ($DryRun) { "Would delete: $($deleted.Count)" } else { "Deleted: $($deleted.Count)" }),
    "Already missing: $($missing.Count)",
    "Skipped: $($skipped.Count)",
    "Failed: $($failed.Count)"
)
if (-not $DryRun -and -not $KeepEmptyDirs) {
    $lines += "Empty folders removed: $dirsRemoved"
}
if ($deleted.Count) {
    $lines += ""
    $lines += $(if ($DryRun) { "# Would delete" } else { "# Deleted" })
    $lines += @($deleted)
}
if ($missing.Count) {
    $lines += ""
    $lines += "# Already missing"
    $lines += @($missing)
}
if ($skipped.Count) {
    $lines += ""
    $lines += "# Skipped"
    $lines += @($skipped)
}
if ($failed.Count) {
    $lines += ""
    $lines += "# Failed"
    $lines += @($failed)
}
$lines -join "`n" | Write-Host
if ($failed.Count) { exit 1 }
