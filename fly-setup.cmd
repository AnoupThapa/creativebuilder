@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title PostGenX - put it online with Fly.io
echo.
echo  ============================================================
echo    PostGenX - put it online with Fly.io (first-time setup)
echo  ============================================================
echo.

rem ---- 1. the Fly.io tool -------------------------------------------------
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where fly >nul 2>nul
if %errorlevel%==0 goto :havefly
echo  Installing the Fly.io tool (one time only)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://fly.io/install.ps1 -useb | iex"
where fly >nul 2>nul
if not %errorlevel%==0 (
  echo.
  echo  Could not install the Fly.io tool. Check your internet connection and try again.
  goto :fail
)
:havefly

rem ---- 2. sign in (opens your browser) ------------------------------------
fly auth whoami >nul 2>nul
if %errorlevel%==0 goto :signedin
echo.
echo  Your browser will open. Sign up or log in to Fly.io there, then come back here.
pause
fly auth login
fly auth whoami >nul 2>nul
if not %errorlevel%==0 (
  echo  Sign-in did not complete.
  goto :fail
)
:signedin

rem ---- 3. app name ----------------------------------------------------------
set "APP=creativebuilder"
echo.
echo  Your site address will be https://NAME.fly.dev
set /p "APPIN=  App name (press Enter for %APP%): "
if not "%APPIN%"=="" set "APP=%APPIN%"
powershell -NoProfile -Command "(Get-Content fly.toml) -replace '^app = \".*\"', 'app = \"%APP%\"' | Set-Content fly.toml -Encoding ASCII"

fly status -a %APP% >nul 2>nul
if %errorlevel%==0 goto :appexists
echo  Creating the app %APP%...
fly apps create %APP%
if not %errorlevel%==0 (
  echo.
  echo  That name is taken or could not be created. Run this file again and choose another name.
  goto :fail
)
:appexists

rem ---- 4. permanent disk for the database and photos -------------------------
fly volumes list -a %APP% 2>nul | findstr /i "postforge_data" >nul
if %errorlevel%==0 goto :havevolume
echo  Creating a 1 GB permanent disk in Singapore...
fly volumes create postforge_data --region sin --size 1 -a %APP% -y
if not %errorlevel%==0 goto :fail
:havevolume

rem ---- 5. settings (only asked the first time) -------------------------------
fly secrets list -a %APP% 2>nul | findstr /i "APP_SECRET" >nul
if %errorlevel%==0 goto :havesecrets
echo.
echo  Platform admin login for the online site.
echo  (Use letters and numbers only in the password, at least 10 characters.)
set /p "AEMAIL=  Admin email: "
set /p "APASS=  Admin password: "
set /p "SEMAIL=  Support email (where customer messages go, can be the same): "
for /f %%s in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set "SECRET=%%s"
fly secrets set --stage -a %APP% APP_SECRET=%SECRET% ADMIN_EMAIL=%AEMAIL% ADMIN_PASSWORD=%APASS% SUPPORT_EMAIL=%SEMAIL% APP_URL=https://%APP%.fly.dev
if not %errorlevel%==0 goto :fail
:havesecrets

rem ---- 6. build and start it ---------------------------------------------------
echo.
echo  Building and starting PostGenX online (3-6 minutes the first time)...
fly deploy -a %APP% --ha=false
if not %errorlevel%==0 goto :fail

echo.
echo  ============================================================
echo    Done! PostGenX is online at  https://%APP%.fly.dev
echo    Next: log in, then Account ^& security - turn on 2-step login.
echo    To publish changes later, double-click fly-update.cmd
echo  ============================================================
start "" https://%APP%.fly.dev
pause
exit /b 0

:fail
echo.
echo  Setup stopped. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
