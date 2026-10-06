@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title PostGenX - repair the Fly.io app
set "APP=creativebuilder"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
echo.
echo  ============================================================
echo    PostGenX - repair the Fly.io app "%APP%"
echo    Moves it to ONE server in Singapore with a permanent disk.
echo  ============================================================
echo.
echo  Before you continue: make sure a payment card is added in Fly.io
echo  (fly.io - Billing - Add payment method). Without it Fly keeps
echo  suspending the app.
echo.
pause

rem ---- Fly.io tool + sign-in ---------------------------------------------
where fly >nul 2>nul
if %errorlevel%==0 goto :havefly
echo  Installing the Fly.io tool...
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://fly.io/install.ps1 -useb | iex"
where fly >nul 2>nul
if not %errorlevel%==0 goto :fail
:havefly
fly auth whoami >nul 2>nul
if %errorlevel%==0 goto :signedin
echo  Your browser will open - sign in to the Fly.io account that has "%APP%".
fly auth login
fly auth whoami >nul 2>nul
if not %errorlevel%==0 goto :fail
:signedin
fly status -a %APP% >nul 2>nul
if not %errorlevel%==0 (
  echo.
  echo  The app "%APP%" was not found in this Fly.io account.
  echo  Sign in with the right account: run  fly auth logout  then start this file again.
  goto :fail
)

rem ---- remove the old servers (Amsterdam, no permanent disk) ----------------
echo.
echo  Removing the old servers of %APP% (they hold no saved data)...
for /f "usebackq delims=" %%m in (`powershell -NoProfile -Command "try { (fly machine list -a %APP% --json | ConvertFrom-Json) | ForEach-Object { $_.id } } catch {}"`) do (
  echo    - %%m
  fly machine destroy %%m -a %APP% --force
)

rem ---- permanent disk in Singapore ---------------------------------------
fly volumes list -a %APP% 2>nul | findstr /i "postforge_data" | findstr /i "sin" >nul
if %errorlevel%==0 goto :havevolume
echo  Creating a 1 GB permanent disk in Singapore...
fly volumes create postforge_data --region sin --size 1 -a %APP% -y
if not %errorlevel%==0 goto :fail
:havevolume

rem ---- settings the app needs ----------------------------------------------
fly secrets list -a %APP% 2>nul | findstr /i "APP_SECRET" >nul
if %errorlevel%==0 goto :secretok
for /f %%s in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set "SECRET=%%s"
fly secrets set --stage -a %APP% APP_SECRET=%SECRET%
:secretok
fly secrets list -a %APP% 2>nul | findstr /i "ADMIN_EMAIL" >nul
if %errorlevel%==0 goto :adminok
echo.
echo  Platform admin login for the online site.
echo  (Use letters and numbers only in the password, at least 10 characters.)
set /p "AEMAIL=  Admin email: "
set /p "APASS=  Admin password: "
set /p "SEMAIL=  Support email (where customer messages go): "
fly secrets set --stage -a %APP% ADMIN_EMAIL=%AEMAIL% ADMIN_PASSWORD=%APASS% SUPPORT_EMAIL=%SEMAIL%
:adminok
fly secrets set --stage -a %APP% APP_URL=https://%APP%.fly.dev

rem ---- publish: one server, Singapore ------------------------------------------
echo.
echo  Building and starting PostGenX (3-6 minutes)...
fly deploy -a %APP% --ha=false
if not %errorlevel%==0 goto :fail
fly scale count 1 -a %APP% -y >nul 2>nul

echo.
echo  ============================================================
echo    Fixed!  https://%APP%.fly.dev
echo    Log in, then Account ^& security - turn on 2-step login.
echo  ============================================================
fly status -a %APP%
start "" https://%APP%.fly.dev
pause
exit /b 0

:fail
echo.
echo  Stopped. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
