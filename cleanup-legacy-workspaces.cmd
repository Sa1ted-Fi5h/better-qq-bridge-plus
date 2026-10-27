@echo off
chcp 65001>nul
cd /d "%~dp0"
where node>nul 2>nul
if errorlevel 1 set "PATH=C:\Users\Admin\tools\nodejs;%PATH%"
echo.
echo  Cleaning legacy DSH workspaces that point to the old qq-bridge folder.
echo  Requirement: DeepSeek Harness must be FULLY closed first.
echo.
node scripts\cleanup-legacy-workspaces.mjs --relaunch
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo  FAILED - see messages above.
) else (
  echo  Done. DeepSeek Harness is starting again.
)
pause
