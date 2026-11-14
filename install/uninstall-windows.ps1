# Removes the Live Layer service. Your app data stays in %LOCALAPPDATA%\LiveLayer unless you pass -RemoveData.
param([switch]$RemoveData)
$Home_ = Join-Path $env:LOCALAPPDATA "LiveLayer"
$Bin = Join-Path $Home_ "bin"
Stop-ScheduledTask -TaskName "LiveLayer" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "LiveLayer" -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*LiveLayer*llpd.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) { [Environment]::SetEnvironmentVariable("Path", (($userPath -split ";") | Where-Object { $_ -and $_ -ne $Bin }) -join ";", "User") }
Remove-Item -Recurse -Force (Join-Path $Home_ "app"), $Bin, (Join-Path $Home_ "start-llpd.vbs") -ErrorAction SilentlyContinue
if ($RemoveData) { Remove-Item -Recurse -Force $Home_ -ErrorAction SilentlyContinue; Write-Host "Removed the service and all app data." }
else { Write-Host "Removed the service. App data kept in $Home_ (run with -RemoveData to delete it)." }
