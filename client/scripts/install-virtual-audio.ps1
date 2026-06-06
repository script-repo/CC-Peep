# Install a virtual audio device on a headless Windows VM so the CC-Peep audio bridge
# has a render/capture endpoint to work with (WASAPI loopback needs a playback device).
#
# Uses Scream (https://github.com/duncanthrax/scream), a signed virtual sound card.
# On Windows Server 2012 R2 the bundled batch installer works (the devcon
# incompatibility only affects Windows 11), and cross-signed drivers install without
# test-signing. We pre-trust the driver certificate so install runs unattended.
#
#   powershell -ExecutionPolicy Bypass -File client\scripts\install-virtual-audio.ps1
#
# Run from an ELEVATED (Administrator) PowerShell.

param(
  [string]$Version = "4.0",
  [switch]$KeepDownload
)

$ErrorActionPreference = "Stop"

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Installing a driver requires an elevated session. Re-run this from an Administrator PowerShell."
}

[Net.ServicePointManager]::SecurityProtocol =
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Extract a zip (PS4-safe): prefer .NET ZipFile, else Shell COM with a wait.
function Expand-ZipSafe($zip, $dest) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
    return
  } catch {}
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
  $shell = New-Object -ComObject Shell.Application
  $items = $shell.NameSpace($zip).Items()
  $expected = $items.Count
  $shell.NameSpace($dest).CopyHere($items, 0x14)
  $waited = 0
  while (((Get-ChildItem $dest -Force | Measure-Object).Count -lt $expected) -and ($waited -lt 120)) {
    Start-Sleep -Milliseconds 500; $waited++
  }
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$cache = Join-Path $env:LOCALAPPDATA "cc-peep-scream"
$zip = Join-Path $env:TEMP "Scream$Version.zip"
$extract = Join-Path $cache "Scream$Version"

Write-Step "Downloading Scream $Version ($arch)…"
$url = "https://github.com/duncanthrax/scream/releases/download/$Version/Scream$Version.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Write-Step "Extracting…"
Expand-ZipSafe $zip $extract

# Locate the driver files for this architecture.
$inf = Get-ChildItem -Path $extract -Recurse -Filter "Scream.inf" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
if (-not $inf) { $inf = Get-ChildItem -Path $extract -Recurse -Filter "Scream.inf" -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $inf) { throw "Scream.inf not found under $extract. Inspect the extracted folder manually." }
$driverDir = $inf.DirectoryName
$sys = Join-Path $driverDir "Scream.sys"
Write-Ok "Driver: $($inf.FullName)"

# Pre-trust the driver's publisher certificate so the install runs without a
# "Would you like to install this device software?" prompt.
if (Test-Path $sys) {
  try {
    $sig = Get-AuthenticodeSignature $sys
    if ($sig.SignerCertificate) {
      Write-Step "Trusting driver publisher certificate…"
      foreach ($name in @("TrustedPublisher", "Root")) {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, "LocalMachine")
        $store.Open("ReadWrite")
        $store.Add($sig.SignerCertificate)
        $store.Close()
      }
      Write-Ok "Certificate added to TrustedPublisher + Root."
    }
  } catch { Write-Warn "Could not pre-trust certificate ($($_.Exception.Message)). You may see a one-time prompt." }
}

# Install the driver. Prefer the bundled batch installer (creates the root-enumerated
# device node via devcon, which works on Server 2012 R2). Fall back to pnputil.
$bat = Get-ChildItem -Path $extract -Recurse -Filter "Install-$arch.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bat) {
  Write-Step "Running installer: $($bat.Name)"
  Push-Location $bat.DirectoryName
  try { cmd.exe /c "`"$($bat.FullName)`"" }
  finally { Pop-Location }
} else {
  Write-Warn "Batch installer not found; falling back to pnputil (may not create the device node)."
  pnputil.exe -i -a "$($inf.FullName)"
}

Start-Sleep -Seconds 2
$dev = Get-WmiObject Win32_SoundDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "Scream" }
if ($dev) {
  Write-Ok "Installed: $($dev.Name)"
} else {
  Write-Warn "Scream device not detected yet. A reboot may be required; then check Sound settings."
}

if (-not $KeepDownload) { Remove-Item $zip -ErrorAction SilentlyContinue }

Write-Host ""
Write-Step "Next steps"
Write-Host "  1. Open Sound settings (run: mmsys.cpl) and set 'Scream' as the DEFAULT" -ForegroundColor Gray
Write-Host "     playback device, so app audio routes through it and loopback can capture it." -ForegroundColor Gray
Write-Host "  2. If the device is missing, reboot once and re-check." -ForegroundColor Gray
Write-Host "  3. Then run the audio bridge:" -ForegroundColor Gray
Write-Host "       powershell -ExecutionPolicy Bypass -File client\audio-ps\audio-bridge.ps1 -Portal wss://HOST:8080/ws -Session lab" -ForegroundColor DarkGray
