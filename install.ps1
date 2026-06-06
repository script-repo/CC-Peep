# CC-Peep — Windows client single-line installer.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.ps1 | iex"
#
# Installs the audio-agents Windows VM client: ensures Node.js (and git) are present,
# clones the repo, installs dependencies, writes client\config.json, and starts the
# agent so it connects to your Linux portal.
#
# Configure up front (otherwise you'll be prompted where needed):
#   $env:CCPEEP_PORTAL  = "ws://YOUR-LINUX-HOST:8080/ws"
#   $env:CCPEEP_SESSION = "lab"      # optional
#   $env:CCPEEP_NAME    = "vm-1"     # optional
#   $env:CCPEEP_SERVICE = "1"        # auto-start at logon via a Scheduled Task (no prompt)
#   $env:CCPEEP_SERVICE = "0"        # run once in the foreground (no prompt)

$ErrorActionPreference = "Stop"

# GitHub (and nodejs.org) require TLS 1.2; older Windows / PowerShell default to TLS 1.0.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$Repo      = "https://github.com/script-repo/CC-Peep.git"
$ZipUrl    = "https://github.com/script-repo/CC-Peep/archive/refs/heads/main.zip"
$Branch    = "main"
$InstallDir = Join-Path $env:LOCALAPPDATA "CC-Peep"
# Portable Node version used when winget is unavailable (override: $env:CCPEEP_NODE_VERSION).
$NodeVersion = if ($env:CCPEEP_NODE_VERSION) { $env:CCPEEP_NODE_VERSION } else { "v20.18.0" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user    = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ";"
}

# Extract a zip. Expand-Archive needs PowerShell 5+, so fall back to the Shell COM API
# (available on older Windows / PowerShell 4).
function Expand-Zip($zipPath, $destDir) {
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
  if (Test-Command "Expand-Archive") {
    Expand-Archive -Path $zipPath -DestinationPath $destDir -Force
  } else {
    $shell = New-Object -ComObject Shell.Application
    $items = $shell.NameSpace($zipPath).Items()
    # 0x10 = yes-to-all, 0x4 = no progress UI.
    $shell.NameSpace($destDir).CopyHere($items, 0x14)
  }
}

function Install-WithWinget($id, $label) {
  Write-Step "Installing $label via winget…"
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Update-PathFromRegistry
}

# winget-free Node install: download the official portable zip from nodejs.org and put
# it on PATH for this session. Works on old Windows Server with no package manager.
function Install-NodePortable {
  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  $name = "node-$NodeVersion-win-$arch"
  $url  = "https://nodejs.org/dist/$NodeVersion/$name.zip"
  $zip  = Join-Path $env:TEMP "$name.zip"
  $tmp  = Join-Path $env:TEMP "cc-peep-node"
  $target = Join-Path $InstallDir "node"

  Write-Step "Downloading portable Node.js $NodeVersion ($arch)…"
  Invoke-WebRequest -Uri $url -OutFile $zip
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item (Join-Path $tmp $name) $target
  Remove-Item -Force $zip
  $env:Path = "$target;$env:Path"
}

function Ensure-Node {
  if (Test-Command "node") {
    Write-Ok "Node.js found: $(node --version)"
    return
  }
  if (Test-Command "winget") {
    try {
      Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
    } catch {
      Write-Warn "winget install failed ($($_.Exception.Message)); using portable Node."
    }
  } else {
    Write-Warn "winget unavailable; using portable Node from nodejs.org."
  }
  if (-not (Test-Command "node")) { Install-NodePortable }
  if (-not (Test-Command "node")) {
    throw "Node.js still not on PATH. Install Node.js $NodeVersion+ manually, then re-run."
  }
  Write-Ok "Node.js ready: $(node --version)"
}

function Get-Source {
  if (Test-Command "git") {
    if (Test-Path (Join-Path $InstallDir ".git")) {
      Write-Step "Updating existing checkout at $InstallDir…"
      git -C $InstallDir fetch --depth 1 origin $Branch | Out-Null
      git -C $InstallDir reset --hard "origin/$Branch" | Out-Null
    } else {
      Write-Step "Cloning $Repo -> $InstallDir…"
      if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
      git clone --depth 1 --branch $Branch $Repo $InstallDir | Out-Null
    }
  } else {
    Write-Warn "git not found — downloading source archive instead."
    $tmpZip = Join-Path $env:TEMP "cc-peep.zip"
    Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    $extractTo = Join-Path $env:TEMP "cc-peep-extract"
    if (Test-Path $extractTo) { Remove-Item -Recurse -Force $extractTo }
    Expand-Zip $tmpZip $extractTo
    $inner = Get-ChildItem $extractTo | Select-Object -First 1
    Move-Item $inner.FullName $InstallDir
    Remove-Item -Force $tmpZip
  }
  Write-Ok "Source ready at $InstallDir"
}

function Resolve-PortalUrl {
  if ($env:CCPEEP_PORTAL) { return $env:CCPEEP_PORTAL }
  $url = Read-Host "Portal WebSocket URL (e.g. ws://192.168.1.10:8080/ws)"
  if ([string]::IsNullOrWhiteSpace($url)) { return "ws://localhost:8080/ws" }
  return $url
}

function Install-Client {
  $clientDir = Join-Path $InstallDir "client"
  Write-Step "Installing client dependencies…"
  Push-Location $clientDir
  try {
    npm install --no-audit --no-fund | Out-Null

    $portal  = Resolve-PortalUrl
    $session = if ($env:CCPEEP_SESSION) { $env:CCPEEP_SESSION } else { "lab" }
    $name    = if ($env:CCPEEP_NAME)    { $env:CCPEEP_NAME }    else { "vm-$env:COMPUTERNAME" }

    $config = [ordered]@{ portal = $portal; session = $session; name = $name }
    # Write UTF-8 *without* BOM — Node's JSON.parse rejects a leading BOM, which would
    # silently discard the portal URL and fall back to localhost.
    $json = $config | ConvertTo-Json
    [System.IO.File]::WriteAllText(
      (Join-Path $clientDir "config.json"), $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "Wrote config.json (portal=$portal, session=$session, name=$name)"
  } finally {
    Pop-Location
  }
  return $clientDir
}

Write-Host ""
Write-Host "CC-Peep audio-agents — Windows client installer" -ForegroundColor White
Write-Host "------------------------------------------------" -ForegroundColor DarkGray

function Want-Service {
  if ($env:CCPEEP_SERVICE -eq "1") { return $true }
  if ($env:CCPEEP_SERVICE -eq "0") { return $false }
  $ans = Read-Host "Auto-start the agent at logon as a background Scheduled Task? [Y/n]"
  return ($ans -notmatch '^[nN]')
}

Ensure-Node
Get-Source
$clientDir = Install-Client

Write-Host ""
if (Want-Service) {
  $register = Join-Path $clientDir "scripts\register-task.ps1"
  Write-Step "Registering background Scheduled Task…"
  & powershell -ExecutionPolicy Bypass -File $register -ClientDir $clientDir
  Write-Host ""
  Write-Host "    Agent installed as a background task. Remove with:" -ForegroundColor DarkGray
  Write-Host "    powershell -File `"$clientDir\scripts\unregister-task.ps1`"" -ForegroundColor DarkGray
} else {
  Write-Step "Starting the agent once in the foreground (Ctrl+C to stop)…"
  Write-Host "    Restart later with:  node `"$clientDir\src\agent.js`"" -ForegroundColor DarkGray
  Write-Host ""
  node (Join-Path $clientDir "src\agent.js")
}
