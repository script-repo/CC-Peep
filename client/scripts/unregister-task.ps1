# Stop and remove the CC-Peep Windows client Scheduled Task.
#
#   powershell -ExecutionPolicy Bypass -File client\scripts\unregister-task.ps1

param(
  [string]$TaskName = "CC-Peep Audio Agent"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Task '$TaskName' is not registered. Nothing to do." -ForegroundColor Yellow
  return
}

Write-Host "==> Stopping and removing '$TaskName'..." -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "    Removed." -ForegroundColor Green
