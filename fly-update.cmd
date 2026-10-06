@echo off
setlocal
cd /d "%~dp0"
title PostGenX - publish changes to Fly.io
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
echo  Publishing the latest PostGenX to Fly.io (about 2-4 minutes)...
fly deploy --ha=false
if not %errorlevel%==0 (
  echo.
  echo  Publishing failed. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)
for /f "tokens=3 delims= " %%a in ('findstr /b /c:"app = " fly.toml') do set "APP=%%~a"
echo.
echo  Done - https://%APP%.fly.dev is up to date.
start "" https://%APP%.fly.dev
pause
