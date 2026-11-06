' Runs the Phi-nguin server with no console window, and restarts it if it stops.
' Started at logon by the "Phi-nguin" scheduled task. Output goes to logs\server.log.
' To stop it, run stop.bat.
Option Explicit

Dim fso, sh, dir, logDir, logFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = dir & "\logs"
logFile = logDir & "\server.log"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
sh.CurrentDirectory = dir

cmd = "cmd /c node """ & dir & "\server.js"" >> """ & logFile & """ 2>&1"

Do
  ' Keep the log small: start fresh once it passes 1 MB.
  If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 1048576 Then fso.DeleteFile logFile, True
  End If
  sh.Run cmd, 0, True   ' 0 = hidden window, True = wait until node exits
  WScript.Sleep 10000   ' wait 10s before restarting after a crash
Loop
