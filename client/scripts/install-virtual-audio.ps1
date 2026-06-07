# Install a virtual audio device on a headless Windows VM so the CC-Peep audio bridge
# has an endpoint to work with. Two drivers are supported:
#
#   -Driver Scream   (default) virtual PLAYBACK device. Loopback-capture it to send
#                    the VM's app audio to the browser (audio.out).
#   -Driver VBCable  virtual cable that ALSO exposes a RECORDING device. Play the
#                    browser mic into "CABLE Input" and VM apps read "CABLE Output"
#                    as their microphone (audio.in -> VM apps). Needed for a virtual mic.
#
# For full duplex with VM apps install BOTH: apps' speaker = Scream, apps' mic = CABLE
# Output; run the bridge with -CaptureDevice Scream -PlaybackDevice "CABLE Input".
#
#   powershell -ExecutionPolicy Bypass -File client\scripts\install-virtual-audio.ps1 -Driver VBCable
#
# Run from an ELEVATED (Administrator) PowerShell.

param(
  [ValidateSet("Scream", "VBCable")] [string]$Driver = "Scream",
  [string]$ScreamVersion = "4.0",
  [string]$VBCableUrl = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip",
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

# Pre-trust a driver's publisher certificate so installs run without the
# "Would you like to install this device software?" prompt.
function Trust-DriverCert($file) {
  try {
    $sig = Get-AuthenticodeSignature $file
    if (-not $sig.SignerCertificate) { Write-Warn "No signature on $file; you may see a one-time prompt."; return }
    Write-Step "Trusting driver publisher certificate ($([IO.Path]::GetFileName($file)))..."
    foreach ($name in @("TrustedPublisher", "Root")) {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, "LocalMachine")
      $store.Open("ReadWrite"); $store.Add($sig.SignerCertificate); $store.Close()
    }
    Write-Ok "Certificate added to TrustedPublisher + Root."
  } catch { Write-Warn "Could not pre-trust certificate ($($_.Exception.Message)). You may see a one-time prompt." }
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

function Install-Scream {
  $cache = Join-Path $env:LOCALAPPDATA "cc-peep-scream"
  $zip = Join-Path $env:TEMP "Scream$ScreamVersion.zip"
  $extract = Join-Path $cache "Scream$ScreamVersion"

  Write-Step "Downloading Scream $ScreamVersion ($arch)..."
  Invoke-WebRequest -Uri "https://github.com/duncanthrax/scream/releases/download/$ScreamVersion/Scream$ScreamVersion.zip" -OutFile $zip
  Write-Step "Extracting..."
  Expand-ZipSafe $zip $extract

  $inf = Get-ChildItem -Path $extract -Recurse -Filter "Scream.inf" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
  if (-not $inf) { $inf = Get-ChildItem -Path $extract -Recurse -Filter "Scream.inf" -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $inf) { throw "Scream.inf not found under $extract." }
  Write-Ok "Driver: $($inf.FullName)"

  $sys = Join-Path $inf.DirectoryName "Scream.sys"
  if (Test-Path $sys) { Trust-DriverCert $sys }

  $bat = Get-ChildItem -Path $extract -Recurse -Filter "Install-$arch.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($bat) {
    Write-Step "Running installer: $($bat.Name)"
    Push-Location $bat.DirectoryName
    # Pipe empty stdin so a trailing `pause` in the batch cannot hang an unattended run.
    try { "" | cmd.exe /c "`"$($bat.FullName)`"" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Scream's devcon step returned $LASTEXITCODE. On Server 2012 R2 this"
      Write-Warn "often fails due to driver-signing. Prefer VB-CABLE: re-run with -Driver VBCable."
    }
  } else {
    Write-Warn "Batch installer not found; falling back to pnputil."
    pnputil.exe -i -a "$($inf.FullName)"
  }
  if (-not $KeepDownload) { Remove-Item $zip -ErrorAction SilentlyContinue }
  return "Scream"
}

function Install-VBCable {
  $cache = Join-Path $env:LOCALAPPDATA "cc-peep-vbcable"
  $zip = Join-Path $env:TEMP "vbcable.zip"

  Write-Step "Downloading VB-CABLE..."
  Invoke-WebRequest -Uri $VBCableUrl -OutFile $zip
  Write-Step "Extracting..."
  Expand-ZipSafe $zip $cache

  $cat = Get-ChildItem -Path $cache -Recurse -Filter "*.cat" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "64" } | Select-Object -First 1
  if (-not $cat) { $cat = Get-ChildItem -Path $cache -Recurse -Filter "*.cat" -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($cat) { Trust-DriverCert $cat.FullName } else { Write-Warn "No .cat found to pre-trust; expect a Windows Security prompt." }

  $setupName = if ($arch -eq "x64") { "VBCABLE_Setup_x64.exe" } else { "VBCABLE_Setup.exe" }
  $setup = Get-ChildItem -Path $cache -Recurse -Filter $setupName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $setup) { throw "$setupName not found under $cache." }

  Write-Step "Running VB-CABLE setup (silent)..."
  # -h -i -H -n = hidden, install, no UI, no reboot prompt. If the cert wasn't trusted
  # a one-time Windows Security dialog may still appear; click Install.
  $p = Start-Process -FilePath $setup.FullName -ArgumentList "-h", "-i", "-H", "-n" -PassThru -Wait
  Write-Ok "Setup exited with code $($p.ExitCode)."
  if (-not $KeepDownload) { Remove-Item $zip -ErrorAction SilentlyContinue }
  return "CABLE"
}

if ($Driver -eq "VBCable") { $match = Install-VBCable } else { $match = Install-Scream }

Start-Sleep -Seconds 2
$dev = Get-WmiObject Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $match }
if ($dev) { $dev | ForEach-Object { Write-Ok "Installed: $($_.Name)" } }
else { Write-Warn "$Driver device not detected yet. A reboot may be required; then re-check." }

Write-Host ""
Write-Step "Next steps"
if ($Driver -eq "VBCable") {
  Write-Host "  1. Reboot if the device isn't listed yet." -ForegroundColor Gray
  Write-Host "  2. In the VM app you want to feed, set its MICROPHONE to" -ForegroundColor Gray
  Write-Host "     'CABLE Output (VB-Audio Virtual Cable)'." -ForegroundColor Gray
  Write-Host "  3. Run the bridge so your browser mic plays into CABLE Input:" -ForegroundColor Gray
  Write-Host "       audio-bridge.ps1 -Portal wss://HOST:8080/ws -Session lab -PlaybackDevice `"CABLE Input`" -CaptureDevice Scream" -ForegroundColor DarkGray
  Write-Host "     (-CaptureDevice Scream lets you also hear VM app audio in the browser, echo-free.)" -ForegroundColor Gray
} else {
  Write-Host "  1. Open Sound settings (mmsys.cpl) and set 'Scream' as the DEFAULT" -ForegroundColor Gray
  Write-Host "     playback device so app audio routes through it for loopback capture." -ForegroundColor Gray
  Write-Host "  2. Reboot once if the device is missing, then re-check." -ForegroundColor Gray
  Write-Host "  3. Then run the audio bridge:" -ForegroundColor Gray
  Write-Host "       audio-bridge.ps1 -Portal wss://HOST:8080/ws -Session lab" -ForegroundColor DarkGray
}
