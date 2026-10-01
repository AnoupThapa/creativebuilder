@echo off
setlocal
cd /d "%~dp0"
title PostForge - switch on real Facebook and Instagram posting
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
echo.
echo  Paste the details from your Meta app (developers.facebook.com - App settings - Basic).
echo  Leave Configuration ID empty unless the setup guide told you to create one.
echo.
set /p "MID=  App ID: "
set /p "MSECRET=  App Secret: "
set /p "MCONF=  Configuration ID (optional, press Enter to skip): "
if "%MID%"=="" goto :fail
if "%MSECRET%"=="" goto :fail
if "%MCONF%"=="" (
  fly secrets set META_APP_ID=%MID% META_APP_SECRET=%MSECRET%
) else (
  fly secrets set META_APP_ID=%MID% META_APP_SECRET=%MSECRET% META_LOGIN_CONFIG_ID=%MCONF%
)
if not %errorlevel%==0 goto :fail
echo.
echo  Done. PostForge restarts by itself in about a minute.
echo  Then open Social posts and click "Connect Facebook ^& Instagram".
pause
exit /b 0
:fail
echo.
echo  Not saved. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
