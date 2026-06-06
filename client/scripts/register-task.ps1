# Register the CC-Peep Windows client as a Scheduled Task so it auto-starts and
# keeps running (restarts on failure / reboot). Runs in the interactive user session
# so WASAPI audio capture has access to the user's audio devices.
#
#   powershell -ExecutionPolicy Bypass -File client\scripts\register-task.ps1
#
# Optional params let you override the install location or task name.

param(
  [string]$ClientDir = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName  = "CC-Peep Audio Agent",
  # Absolute path to node.exe. Falls back to PATH resolution when not supplied.
  [string]$NodePath
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Registering a Scheduled Task requires an elevated session. Re-run this script (or install.ps1) from an Administrator PowerShell."
}

$agent = Join-Path $ClientDir "src\agent.js"
if (-not (Test-Path $agent)) {
  throw "Agent not found at $agent. Pass -ClientDir pointing at the client/ folder."
}

$node = $NodePath
if (-not $node) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $node = $nodeCmd.Source }
}
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path $node)) {
  throw "node.exe not found (NodePath='$NodePath'). Pass -NodePath or ensure node is on PATH."
}

Write-Host "==> Registering Scheduled Task '$TaskName'" -ForegroundColor Cyan
Write-Host "    node:  $node"
Write-Host "    agent: $agent"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$agent`"" -WorkingDirectory $ClientDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "==> Starting task now..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName

Write-Host "    Done. The agent will start at every logon and restart if it exits." -ForegroundColor Green
Write-Host "    Manage it: Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo" -ForegroundColor DarkGray
Write-Host "    Remove it: powershell -File `"$PSScriptRoot\unregister-task.ps1`"" -ForegroundColor DarkGray
