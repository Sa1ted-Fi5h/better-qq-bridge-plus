@echo off
chcp 65001 >nul
setlocal
set "VBS=%~dp0keepalive.vbs"
if not exist "%VBS%" (
  echo [ERROR] not found: %VBS%
  pause
  exit /b 1
)
echo Switching "qq-bridge keepalive" to silent launcher (wscript)...
schtasks /change /tn "qq-bridge keepalive" /tr "wscript.exe //nologo \"%VBS%\"" >nul 2>nul
if errorlevel 1 (
  schtasks /create /tn "qq-bridge keepalive" /tr "wscript.exe //nologo \"%VBS%\"" /sc minute /mo 5 /rl LIMITED /f
)
if errorlevel 1 (
  echo [ERROR] failed. Run this file as Administrator.
  pause
  exit /b 1
)
echo Done. The keepalive check will run silently every 5 minutes now.
pause