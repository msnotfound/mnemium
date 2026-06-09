# Mnemium daemon installer for Windows (PowerShell 5+).
#
# Usage (one-liner from a fresh PowerShell window):
#   irm https://github.com/msnotfound/mnemium/releases/latest/download/install.ps1 | iex
#
# What it does:
#   1. Detects your CPU arch (amd64 / arm64).
#   2. Fetches the latest release tag from GitHub's API.
#   3. Downloads the matching mnemiumd-windows-<arch>.zip + checksums.txt.
#   4. Verifies the SHA-256.
#   5. Extracts to $env:LOCALAPPDATA\Mnemium\bin\.
#   6. Adds that directory to your User PATH (one-time).
#
# Override the install dir with $env:MNEMIUM_BIN_DIR before running.

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (the system default on Win10/11) defaults to TLS 1.0
# for outbound HTTPS, which GitHub rejects at the SSL handshake — Invoke-
# RestMethod/Invoke-WebRequest blow up with "connection was closed
# unexpectedly". Force TLS 1.2 (and keep whatever else is enabled).
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo       = "msnotfound/mnemium"
$BinName    = "mnemiumd.exe"
$DefaultDir = Join-Path $env:LOCALAPPDATA "Mnemium\bin"
$TargetDir  = if ($env:MNEMIUM_BIN_DIR) { $env:MNEMIUM_BIN_DIR } else { $DefaultDir }

function Write-Step($msg) { Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host ("    " + $msg) -ForegroundColor Green }
function Write-Err($msg)  { Write-Host ("!!! " + $msg) -ForegroundColor Red }

Write-Step "Detecting platform"
$arch = (Get-CimInstance Win32_Processor).Architecture
switch ($arch) {
    9  { $goarch = "amd64" }       # x64
    12 { $goarch = "arm64" }       # ARM64
    default {
        Write-Err "Unsupported CPU architecture code: $arch (need x64 or ARM64)."
        Write-Err "Open an issue or download manually from the releases page."
        exit 1
    }
}
Write-OK "Windows / $goarch"

Write-Step "Resolving latest release"
$api = "https://api.github.com/repos/$Repo/releases/latest"
try {
    $release = Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "mnemium-installer" } -Uri $api
} catch {
    Write-Err "Failed to query GitHub: $_"
    Write-Err "If the repo is private, you must download manually with a personal access token."
    exit 1
}
$tag = $release.tag_name
Write-OK "Latest is $tag"

$zipName     = "mnemiumd_${tag}_windows_${goarch}.zip"
$zipNameAlt  = "mnemiumd-windows-${goarch}.zip"
$zipAsset    = $release.assets | Where-Object { $_.name -eq $zipName -or $_.name -eq $zipNameAlt } | Select-Object -First 1
$sumsAsset   = $release.assets | Where-Object { $_.name -eq "checksums.txt" }            | Select-Object -First 1

if (-not $zipAsset) {
    $available = ($release.assets | ForEach-Object { $_.name }) -join ", "
    Write-Err "No asset matching mnemiumd-windows-${goarch}.zip in $tag."
    Write-Err "Available assets: $available"
    exit 1
}

$tmp = Join-Path $env:TEMP ("mnemium-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipPath  = Join-Path $tmp $zipAsset.name
    $sumsPath = Join-Path $tmp "checksums.txt"

    Write-Step "Downloading $($zipAsset.name) ($([math]::Round($zipAsset.size/1MB, 1)) MB)"
    Invoke-WebRequest -UseBasicParsing -Uri $zipAsset.browser_download_url -OutFile $zipPath

    if ($sumsAsset) {
        Invoke-WebRequest -UseBasicParsing -Uri $sumsAsset.browser_download_url -OutFile $sumsPath
        Write-Step "Verifying SHA-256"
        # checksums.txt lines are "<hex>  <filename>". Parse line-by-line
        # so we get just the hash field, not Select-String's MatchInfo
        # stringification (which prepends "<file>:<lineno>:").
        $expected = $null
        foreach ($line in (Get-Content $sumsPath)) {
            $fields = $line.Trim() -split '\s+'
            if ($fields.Count -ge 2 -and $fields[1] -eq $zipAsset.name) {
                $expected = $fields[0].ToLower()
                break
            }
        }
        if (-not $expected) {
            Write-Err "checksums.txt has no entry for $($zipAsset.name) — refusing to install."
            exit 1
        }
        $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
        if ($actual -ne $expected) {
            Write-Err "SHA-256 mismatch! expected $expected, got $actual"
            exit 1
        }
        Write-OK "SHA-256 verified"
    } else {
        Write-Host "    (no checksums.txt asset — skipping verification)" -ForegroundColor Yellow
    }

    Write-Step "Installing to $TargetDir"
    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir | Out-Null
    }
    Expand-Archive -Force -Path $zipPath -DestinationPath $TargetDir

    $installed = Join-Path $TargetDir $BinName
    if (-not (Test-Path $installed)) {
        # Some archives nest the binary under a folder; try to flatten.
        $nested = Get-ChildItem $TargetDir -Recurse -Filter $BinName | Select-Object -First 1
        if ($nested) {
            Move-Item $nested.FullName $installed -Force
        }
    }
    if (-not (Test-Path $installed)) {
        Write-Err "Extracted archive doesn't contain $BinName — open an issue with the asset name."
        exit 1
    }
    Write-OK "Installed: $installed"

    Write-Step "Updating User PATH"
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$TargetDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$userPath;$TargetDir", "User")
        Write-OK "Added $TargetDir to PATH (open a new PowerShell window for it to take effect)."
    } else {
        Write-OK "PATH already contains $TargetDir"
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  1. Open a NEW PowerShell window (so PATH refreshes)"
Write-Host "  2. Run:  mnemiumd serve"
Write-Host "  3. Copy the pairing string it prints"
Write-Host "  4. Paste it into the Mnemium extension (Settings -> System -> Daemon pairing)"
Write-Host ""
Write-Host "Need the extension? Grab mnemium-extension.zip from the same release:"
Write-Host "  https://github.com/$Repo/releases/tag/$tag"
