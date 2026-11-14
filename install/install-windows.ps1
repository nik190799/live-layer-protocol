# Installs the Live Layer service for the current Windows user. No admin rights needed.
#   - copies the service to %LOCALAPPDATA%\LiveLayer\app
#   - adds the `llp` command to your user PATH
#   - registers a scheduled task that starts the service at sign-in, hidden
#   - starts it now, installs the demo app, and opens it in your browser
# Run from the unzipped folder:   powershell -ExecutionPolicy Bypass -File install\install-windows.ps1

$ErrorActionPreference = "Stop"
$Src  = Split-Path -Parent $PSScriptRoot
$Home_ = Join-Path $env:LOCALAPPDATA "LiveLayer"
$App  = Join-Path $Home_ "app"
$Bin  = Join-Path $Home_ "bin"
$Port = 7710

function Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }

# 1. Check Node.js (22+ needed for the built-in WebSocket client)
Step "Checking Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js isn't installed or isn't on PATH. Install Node 22 or newer from https://nodejs.org and run this again." }
$major = [int]((& $node --version).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node $major found; the service needs Node 22 or newer." }
Write-Host "   node $(& $node --version) at $node"

# 2. Stop an older copy if one is running
Step "Stopping any running copy"
Stop-ScheduledTask -TaskName "LiveLayer" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*LiveLayer*llpd.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 3. Copy files
Step "Copying files to $App"
New-Item -ItemType Directory -Force -Path $App, $Bin | Out-Null
foreach ($d in @("host", "service", "build", "node_modules")) {
  if (Test-Path (Join-Path $App $d)) { Remove-Item -Recurse -Force (Join-Path $App $d) }
  Copy-Item -Recurse -Force (Join-Path $Src $d) (Join-Path $App $d)
}
Copy-Item -Force (Join-Path $Src "package.json") $App

# 4. The `llp` command
Step "Adding the llp command"
Set-Content -Encoding ASCII -Path (Join-Path $Bin "llp.cmd") -Value "@echo off`r`n`"$node`" `"$App\service\llp.mjs`" %*"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
if (($userPath -split ";") -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $Bin).TrimStart(";"), "User")
  Write-Host "   added $Bin to your PATH (open a new terminal to use it)"
}
$env:Path = "$env:Path;$Bin"

# 5. Hidden launcher + scheduled task at sign-in
Step "Registering the service to start at sign-in"
$log = Join-Path $Home_ "llpd.log"
$vbs = Join-Path $Home_ "start-llpd.vbs"
$cmd = "cmd /c """"$node"" ""$App\service\llpd.mjs"" --port $Port >> ""$log"" 2>&1"""
Set-Content -Encoding ASCII -Path $vbs -Value "CreateObject(""WScript.Shell"").Run ""$($cmd.Replace('"','""'))"", 0, False"
$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "LiveLayer" -Action $action -Trigger $trigger -Settings $settings -Description "Live Layer service: runs streamed live apps" -Force | Out-Null

# 6. Start now and wait for it
Step "Starting the service"
Start-ScheduledTask -TaskName "LiveLayer"
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { Invoke-RestMethod "http://127.0.0.1:$Port/status" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {}
}
if (-not $ok) { throw "The service didn't start. See the log at $log" }
Write-Host "   running on http://127.0.0.1:$Port"

# 7. Install the demo app and open it
Step "Installing the demo app"
& $node "$App\service\llp.mjs" push demo.tasks "main=$App\build\tasks.wasm" "footer=$App\build\stats.wasm"
Start-Process "http://127.0.0.1:$Port/?app=demo.tasks"

Write-Host ""
Write-Host "Done. Try a live update from a new terminal:" -ForegroundColor Green
Write-Host "   llp push demo.tasks main=$App\build\tasks_v2.wasm footer=$App\build\stats.wasm"
Write-Host "Logs: $log    Data: $Home_"
