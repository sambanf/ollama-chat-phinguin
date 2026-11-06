@echo off
REM Stops the background Phi-nguin server (the auto-start launcher and node).
REM It starts again at your next logon, or right away with: schtasks /Run /TN "Phi-nguin"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = '%~dp0';" ^
  "$procs = Get-CimInstance Win32_Process | Where-Object {" ^
  "  ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like ('*' + $d + 'run-hidden.vbs*')) -or" ^
  "  ($_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $d + 'server.js*')) } | Sort-Object { $_.Name -ne 'wscript.exe' };" ^
  "if (-not $procs) { 'Phi-nguin is not running.' }" ^
  "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; 'Stopped ' + $p.Name + ' (PID ' + $p.ProcessId + ')' }"
if "%1"=="" pause
