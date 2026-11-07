[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Archive,
    [string]$Checksum,
    [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'Programs\dsh'),
    [string]$BaseUrl = 'https://github.com/RainEchoA/dsh-cli-standalone/releases/download',
    [switch]$NoModifyPath
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "Unsafe version string: $Version" }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Only x64 Windows is supported' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw "Unsupported processor architecture: $architecture; only x64 is supported" }
if ([Environment]::OSVersion.Version -lt [Version]'10.0.17763') {
    throw 'Windows 10 1809 / Server 2019 (build 17763) or newer is required for ConPTY'
}

function Get-ExpectedChecksum([string]$Path, [string]$Filename) {
    $matches = @()
    foreach ($line in Get-Content -LiteralPath $Path) {
        $parts = ($line.Trim() -split '\s+', 2)
        if ($parts.Count -eq 2) {
            $name = $parts[1].TrimStart('*')
            if ($name -eq $Filename) { $matches += $parts[0] }
        }
    }
    if ($matches.Count -ne 1) { throw "Expected exactly one checksum for $Filename in $Path; found $($matches.Count)" }
    return $matches[0]
}

function Invoke-Download([string]$Uri, [string]$Destination) {
    Write-Host "Downloading $Uri"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -TimeoutSec 600
    } catch {
        throw "Download failed for ${Uri}: $($_.Exception.Message)"
    }
    if (-not (Test-Path -LiteralPath $Destination) -or (Get-Item -LiteralPath $Destination).Length -eq 0) {
        throw "Downloaded file is empty: $Uri"
    }
}

function Invoke-Dsh([string]$Launcher, [string[]]$Arguments) {
    $output = & $Launcher @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "dsh $($Arguments -join ' ') exited with ${LASTEXITCODE}: $($output | Out-String)"
    }
    return ($output | Out-String).Trim()
}

$work = Join-Path $env:TEMP "dsh-install-$([Guid]::NewGuid().ToString('N'))"
$newVersionDir = $null
$moved = $false
$committed = $false
$oldShim = $null
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    $filename = "dsh-v$Version-win-x64.zip"
    if ($Archive) {
        $Archive = (Resolve-Path -LiteralPath $Archive).Path
        if (-not $Checksum) {
            $checksumPath = "$Archive.sha256"
            if (-not (Test-Path -LiteralPath $checksumPath)) {
                throw 'Local installation requires -Checksum or a sibling .zip.sha256 file'
            }
            $Checksum = Get-ExpectedChecksum $checksumPath (Split-Path -Leaf $Archive)
        }
    } else {
        $releaseUrl = "$BaseUrl/v$Version"
        Write-Host "Resolved dsh version: $Version"
        Write-Host "Download base URL: $releaseUrl"
        if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:http_proxy -or $env:https_proxy) {
            Write-Host 'Proxy environment: set (credentials suppressed)'
        } else {
            Write-Host 'Proxy environment: not set'
        }
        $Archive = Join-Path $work $filename
        Invoke-Download "$releaseUrl/$filename" $Archive
        $checksumPath = "$Archive.sha256"
        Invoke-Download "$releaseUrl/$filename.sha256" $checksumPath
        $Checksum = Get-ExpectedChecksum $checksumPath $filename
    }

    if ($Checksum -notmatch '^[0-9a-fA-F]{64}$') { throw 'Missing or malformed SHA-256 checksum' }
    $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if ($actual -ne $Checksum) {
        throw "Archive checksum mismatch: expected $Checksum, got $actual; installation has not changed"
    }
    Write-Host "Verified archive SHA-256: $actual"

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $normalized = $entry.FullName.Replace('\', '/')
            $segments = $normalized.Split('/')
            if ([System.IO.Path]::IsPathRooted($entry.FullName) -or $normalized.StartsWith('/') -or $segments -contains '..') {
                throw "Unsafe archive entry: $($entry.FullName)"
            }
        }
    } finally {
        $zip.Dispose()
    }
    $unpacked = Join-Path $work 'unpacked'
    New-Item -ItemType Directory -Path $unpacked | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $unpacked)
    $root = Join-Path $unpacked "dsh-v$Version-win-x64"
    $launcher = Join-Path $root 'bin\dsh.cmd'
    if (-not (Test-Path -LiteralPath $launcher)) { throw "Archive does not contain the expected bin\dsh.cmd" }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'runtime\node.exe'))) { throw "Archive does not contain the expected runtime\node.exe" }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'manifest.json'))) { throw "Archive does not contain the expected manifest.json" }

    $reported = Invoke-Dsh $launcher @('--version')
    if ($reported -ne $Version) { throw "Staged dsh --version returned $reported; expected $Version" }
    Invoke-Dsh $launcher @('web', '--help') | Out-Null

    New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
    $Prefix = (Resolve-Path -LiteralPath $Prefix).Path
    $versionsDir = Join-Path $Prefix 'versions'
    $binDir = Join-Path $Prefix 'bin'
    New-Item -ItemType Directory -Force -Path $versionsDir, $binDir | Out-Null
    $newVersionDir = Join-Path $Prefix "versions\$Version"
    if (Test-Path -LiteralPath $newVersionDir) {
        throw "Version $Version is already installed at $newVersionDir; refusing to overwrite it"
    }
    Move-Item -LiteralPath $root -Destination $newVersionDir
    $moved = $true
    Invoke-Dsh (Join-Path $newVersionDir 'bin\dsh.cmd') @('--version') | Out-Null

    $shim = Join-Path $Prefix 'bin\dsh.cmd'
    if (Test-Path -LiteralPath $shim) {
        $oldShim = Join-Path $work 'previous-dsh.cmd'
        Copy-Item -LiteralPath $shim -Destination $oldShim
    }
    $newShim = Join-Path $work 'new-dsh.cmd'
    $shimLines = @(
        '@echo off',
        'setlocal',
        'set "ROOT=%~dp0.."',
        "call `"%ROOT%\versions\$Version\bin\dsh.cmd`" %*",
        'exit /b %ERRORLEVEL%'
    )
    Set-Content -LiteralPath $newShim -Value $shimLines -Encoding Ascii

    if (-not $NoModifyPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @($userPath -split ';' | Where-Object { $_ })
        $present = $false
        foreach ($entry in $entries) {
            if ($entry.TrimEnd('\') -ieq $binDir.TrimEnd('\')) { $present = $true; break }
        }
        if (-not $present) {
            $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$($userPath.TrimEnd(';'));$binDir" }
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Host 'Updated the user PATH; open a new terminal to refresh it'
        }
    } else {
        Write-Host "PATH modification disabled; add $binDir to PATH manually"
    }

    Move-Item -LiteralPath $newShim -Destination $shim -Force
    try {
        $activated = Invoke-Dsh $shim @('--version')
        if ($activated -ne $Version) { throw "Activated shim returned $activated; expected $Version" }
    } catch {
        if ($oldShim) { Copy-Item -LiteralPath $oldShim -Destination $shim -Force }
        else { Remove-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue }
        throw
    }
    $committed = $true
    Write-Host "Installed dsh $Version"
    Write-Host "Launcher: $shim"
    Write-Host "Runtime: $(Join-Path $newVersionDir 'runtime\node.exe')"
} finally {
    if (-not $committed -and $moved -and $newVersionDir -and (Test-Path -LiteralPath $newVersionDir)) {
        Remove-Item -LiteralPath $newVersionDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
