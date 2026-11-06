@echo off
REM Starts the Phi-nguin web app. Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
title Phi-nguin

REM Optional overrides (uncomment to change):
REM set PORT=3000
REM set HOST=127.0.0.1
REM set OLLAMA_URL=http://127.0.0.1:11434

node server.js
pause
