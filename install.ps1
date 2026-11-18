# dsh installer for Windows (PowerShell 5.1+), one file with two equivalent entries:
#
#   irm https://raw.githubusercontent.com/RainEchoA/dsh-cli-standalone/main/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.2.2-rc.1
#
# There is deliberately no top-level param() block: `irm <url> | iex` parses the fetched
# text as a command in the current session, where a param block is a parse error. File
# invocation arguments are therefore collected from $args by the small parser below and
# merged with the DSH_* environment variables (command line wins over environment).
#
# Optional env (all optional; command-line arguments take precedence):
#   DSH_VERSION          Explicit dsh version (no "v" prefix); auto-resolved when unset
#   DSH_ARCHIVE          Local archive; version inferred from the file name when DSH_VERSION is unset
#   DSH_CHECKSUM         Explicit SHA-256 for DSH_ARCHIVE
#   DSH_PREFIX           Install location (default %LOCALAPPDATA%\Programs\dsh)
#   DSH_BASE_URL         Release download base URL
#   DSH_RELEASES_JSON_URL Release index JSON used for version resolution
#   DSH_GH_PROXY         GitHub acceleration proxy (e.g. https://api.gitproxy.dev)
#   DSH_NO_MODIFY_PATH   Non-empty: skip the user PATH update

$dshOuterErrorAction = $ErrorActionPreference
$dshOuterTls = [Net.ServicePointManager]::SecurityProtocol
$dshOuterModulePath = $env:PSModulePath
try {
    $ErrorActionPreference = 'Stop'
    # PowerShell 5.1 on older Windows may not negotiate TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # Collect -File / .\install.ps1 arguments. Under `irm|iex` the command type is not
    # ExternalScript and $args is left untouched, so only environment variables apply.
    $cli = @{}
    if ($MyInvocation.MyCommand.CommandType -eq 'ExternalScript') {
        $tokens = @($args)
        for ($index = 0; $index -lt $tokens.Count; $index++) {
            $token = [string]$tokens[$index]
            switch -Regex ($token) {
                '^(?i)-NoModifyPath$' { $cli['NoModifyPath'] = $true }
                '^(?i)-(Version|Archive|Checksum|Prefix|BaseUrl|ReleasesJsonUrl|GitHubProxy)$' {
                    $index++
                    if ($index -ge $tokens.Count) { throw "$token requires a value" }
                    $cli[$Matches[1]] = [string]$tokens[$index]
                }
                default { throw "Unknown argument: $token" }
            }
        }
    }
    if ($env:DSH_NO_MODIFY_PATH) { $cli['NoModifyPath'] = $true }

    & {
        param(
            [string]$Version = $env:DSH_VERSION,
            [string]$Archive = $env:DSH_ARCHIVE,
            [string]$Checksum = $env:DSH_CHECKSUM,
            [string]$Prefix = $(if ($env:DSH_PREFIX) { $env:DSH_PREFIX } else { Join-Path $env:LOCALAPPDATA 'Programs\dsh' }),
            [string]$BaseUrl = $(if ($env:DSH_BASE_URL) { $env:DSH_BASE_URL } else { 'https://github.com/RainEchoA/dsh-cli-standalone/releases/download' }),
            [string]$ReleasesJsonUrl = $(if ($env:DSH_RELEASES_JSON_URL) { $env:DSH_RELEASES_JSON_URL } else { 'https://rainechoa.github.io/dsh-cli-standalone/releases.json' }),
            [string]$GitHubProxy = $env:DSH_GH_PROXY,
            [switch]$NoModifyPath
        )

        # A pwsh (PowerShell 7) parent exports a PSModulePath that lists PowerShell 7 module
        # folders; under Windows PowerShell that can shadow the built-in modules with the
        # incompatible 7.x copies and lose cmdlets like Get-FileHash. Drop those entries.
        if ($PSVersionTable.PSEdition -eq 'Desktop') {
            $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notlike '*\PowerShell\7*' }) -join ';'
        }
        if (-not [Environment]::Is64BitOperatingSystem) { throw 'Only x64 Windows is supported' }
        $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        if ($architecture -ne 'AMD64') { throw "Unsupported processor architecture: $architecture; only x64 is supported" }
        if ([Environment]::OSVersion.Version -lt [Version]'10.0.17763') {
            throw 'Windows 10 1809 / Server 2019 (build 17763) or newer is required for ConPTY'
        }

        # Semver parsing/comparison mirrors scripts/scan-latest-version.mjs so the installer
        # and the daily version scan pick the same "latest" version.
        function ConvertTo-DshSemVer([string]$Value) {
            $match = [regex]::Match($Value, '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')
            if (-not $match.Success) { return $null }
            $pre = $null
            if ($match.Groups[4].Success) { $pre = $match.Groups[4].Value -split '\.' }
            [pscustomobject]@{
                Major = [int]$match.Groups[1].Value
                Minor = [int]$match.Groups[2].Value
                Patch = [int]$match.Groups[3].Value
                Pre   = $pre
            }
        }

        function Compare-DshSemVer($A, $B) {
            if ($A.Major -ne $B.Major) { return ($A.Major - $B.Major) }
            if ($A.Minor -ne $B.Minor) { return ($A.Minor - $B.Minor) }
            if ($A.Patch -ne $B.Patch) { return ($A.Patch - $B.Patch) }
            if ($null -eq $A.Pre -and $null -eq $B.Pre) { return 0 }
            if ($null -eq $A.Pre) { return 1 }
            if ($null -eq $B.Pre) { return -1 }
            $count = [Math]::Max($A.Pre.Count, $B.Pre.Count)
            for ($index = 0; $index -lt $count; $index++) {
                $left = if ($index -lt $A.Pre.Count) { $A.Pre[$index] } else { $null }
                $right = if ($index -lt $B.Pre.Count) { $B.Pre[$index] } else { $null }
                if ($null -eq $left) { return -1 }
                if ($null -eq $right) { return 1 }
                $leftNumeric = $left -match '^\d+$'
                $rightNumeric = $right -match '^\d+$'
                if ($leftNumeric -and $rightNumeric) {
                    $leftNum = [int]$left
                    $rightNum = [int]$right
                    if ($leftNum -ne $rightNum) { return ($leftNum - $rightNum) }
                } elseif ($leftNumeric -ne $rightNumeric) {
                    if ($leftNumeric) { return -1 } else { return 1 }
                } else {
                    $ordinal = [string]::CompareOrdinal($left, $right)
                    if ($ordinal -ne 0) { return $ordinal }
                }
            }
            return 0
        }

        # Optional GitHub acceleration proxy (e.g. https://gitproxy.dev): rewrites default GitHub
        # URLs into "<proxy>/<original url>". Explicit non-GitHub URLs (custom mirrors) pass through.
        function Resolve-GitHubUrl([string]$Url) {
            if (-not $GitHubProxy) { return $Url }
            if ($Url -match '^https?://(github\.com|raw\.githubusercontent\.com|api\.github\.com|codeload\.github\.com)(/|$)') {
                return "$($GitHubProxy.TrimEnd('/'))/$Url"
            }
            return $Url
        }

        # Probe a release asset at the download base (through the GitHub proxy rewrite when
        # set): 200 means the mirror actually has the version, 404 means it is not synced
        # there yet, and anything else (or a transport error) is a hard failure.
        function Test-DshReleaseAvailable([string]$Version) {
            $uri = Resolve-GitHubUrl "$BaseUrl/v$Version/dsh-v$Version-win-x64.zip.sha256"
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 120
                return ($response.StatusCode -eq 200)
            } catch {
                $status = $null
                if ($_.Exception.Response) {
                    try { $status = [int]$_.Exception.Response.StatusCode } catch { }
                }
                if ($status -eq 404) { return $false }
                throw "Failed to probe ${uri}: $($_.Exception.Message)"
            }
        }

        # Resolve the newest indexed release whose assets are actually downloadable from
        # $BaseUrl: the release index may be fresher than a mirror (e.g. CNB syncs daily),
        # so a version that is listed but not yet mirrored must be skipped, never
        # installed-and-failed halfway.
        function Resolve-DshLatestVersion([string]$JsonUrl) {
            Write-Host "Resolving latest dsh version from $JsonUrl"
            $payload = $null
            try {
                $payload = Invoke-RestMethod -Uri $JsonUrl -TimeoutSec 120
            } catch {
                throw "Failed to read the dsh releases JSON from ${JsonUrl}: $($_.Exception.Message)"
            }
            if ($null -eq $payload -or $null -eq $payload.releases) {
                throw "The document at ${JsonUrl} is not a usable dsh releases index (missing or empty 'releases' array)"
            }
            $eligible = @()
            foreach ($release in @($payload.releases)) {
                $tag = "$($release.version)"
                $parsed = ConvertTo-DshSemVer $tag
                if ($null -eq $parsed) { continue }
                if ($parsed.Pre -and $parsed.Pre[0] -match '^(dev|alpha)$') { continue }
                $eligible += [pscustomobject]@{ Version = $tag; Parsed = $parsed }
            }
            if ($eligible.Count -eq 0) { throw "No installable dsh release found in $JsonUrl (dev/alpha prereleases excluded)" }
            for ($i = 0; $i -lt $eligible.Count; $i++) {
                for ($j = $i + 1; $j -lt $eligible.Count; $j++) {
                    if ((Compare-DshSemVer $eligible[$j].Parsed $eligible[$i].Parsed) -gt 0) {
                        $tmp = $eligible[$i]; $eligible[$i] = $eligible[$j]; $eligible[$j] = $tmp
                    }
                }
            }
            foreach ($candidate in $eligible) {
                Write-Host "Probing $BaseUrl/v$($candidate.Version)/dsh-v$($candidate.Version)-win-x64.zip.sha256"
                if (Test-DshReleaseAvailable $candidate.Version) {
                    Write-Host "Resolved dsh version: $($candidate.Version) (newest available at $BaseUrl)"
                    return "$($candidate.Version)"
                }
            }
            throw "No release listed in $JsonUrl is available for download at $BaseUrl; the download source may lag behind the index"
        }

        # Version resolution, in priority order: explicit -Version, archive file name, latest release.
        if ($Archive) {
            $archiveName = Split-Path -Leaf $Archive
            $archiveMatch = [regex]::Match($archiveName, '^dsh-v(.+)-(win|linux)-x64\.(zip|tar\.gz)$')
            if ($archiveMatch.Success) {
                if (-not $Version) {
                    $Version = $archiveMatch.Groups[1].Value
                    Write-Host "Resolved dsh version: $Version (from archive name '$archiveName')"
                }
                if ($archiveMatch.Groups[2].Value -ne 'win') {
                    throw "Archive '$archiveName' is a $($archiveMatch.Groups[2].Value)-x64 build; this installer only supports win-x64 archives"
                }
            } elseif (-not $Version) {
                throw "Cannot determine the dsh version from archive name '$archiveName'; rename it to dsh-v<version>-win-x64.zip or pass -Version explicitly"
            }
        }
        if (-not $Version) {
            $Version = Resolve-DshLatestVersion $ReleasesJsonUrl
        }
        if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "Unsafe version string: $Version" }

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
                    if (Test-Path -LiteralPath $checksumPath) {
                        $Checksum = Get-ExpectedChecksum $checksumPath (Split-Path -Leaf $Archive)
                    } else {
                        Write-Host "No .sha256 checksum found next to $Archive; skipping checksum verification"
                    }
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
                Invoke-Download (Resolve-GitHubUrl "$releaseUrl/$filename") $Archive
                $checksumPath = "$Archive.sha256"
                Invoke-Download (Resolve-GitHubUrl "$releaseUrl/$filename.sha256") $checksumPath
                $Checksum = Get-ExpectedChecksum $checksumPath $filename
            }

            if ($Checksum) {
                if ($Checksum -notmatch '^[0-9a-fA-F]{64}$') { throw 'Missing or malformed SHA-256 checksum' }
                $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
                if ($actual -ne $Checksum) {
                    throw "Archive checksum mismatch: expected $Checksum, got $actual; installation has not changed"
                }
                Write-Host "Verified archive SHA-256: $actual"
            }

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
                    Write-Host "Added $binDir to your user PATH; open a new terminal to use 'dsh'"
                } else {
                    Write-Host "$binDir is already on your user PATH"
                }
            } else {
                Write-Host "PATH was not modified; add $binDir to your user PATH to use 'dsh' from any terminal"
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

            # Hint: older versions remain on disk after an upgrade. Show which ones are
            # still installed and give the user a copy-paste command to remove them. The
            # active version is always excluded, and only safe directory names are
            # considered so the printed command can never target an unexpected path.
            $versionsRoot = Join-Path $Prefix 'versions'
            $oldVersions = @()
            if (Test-Path -LiteralPath $versionsRoot) {
                foreach ($entry in Get-ChildItem -LiteralPath $versionsRoot -Directory) {
                    if ($entry.Name -eq $Version) { continue }
                    if ($entry.Name -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { continue }
                    $oldVersions += $entry.Name
                }
            }
            if ($oldVersions.Count -gt 0) {
                $quoted = @($oldVersions | ForEach-Object { "'" + (Join-Path $versionsRoot $_).Replace("'", "''") + "'" })
                Write-Host ''
                Write-Host "提示：本机还保留着以下旧版本 dsh：$($oldVersions -join ', ')"
                Write-Host "当前生效版本为 $Version。如需清理旧版本，可执行："
                Write-Host "  Remove-Item -Recurse -Force $($quoted -join ', ')"
            }
        } finally {
            if (-not $committed -and $moved -and $newVersionDir -and (Test-Path -LiteralPath $newVersionDir)) {
                Remove-Item -LiteralPath $newVersionDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    } @cli
} finally {
    $ErrorActionPreference = $dshOuterErrorAction
    [Net.ServicePointManager]::SecurityProtocol = $dshOuterTls
    if ($null -eq $dshOuterModulePath) { Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue }
    else { $env:PSModulePath = $dshOuterModulePath }
}
