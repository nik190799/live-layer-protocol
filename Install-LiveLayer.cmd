@echo off
title Live Layer installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\install-windows.ps1"
echo.
pause
