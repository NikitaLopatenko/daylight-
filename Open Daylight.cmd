@echo off
title Daylight
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo Starting Daylight...
echo Keep this window open while the app is running.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  echo Install Node.js, then try again.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo ERROR: Rust/Cargo was not found.
  echo Open a new terminal after installing Rust, then try again.
  pause
  exit /b 1
)

call npm.cmd run tauri dev
echo.
echo Daylight closed or failed to start.
pause
