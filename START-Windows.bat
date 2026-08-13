@echo off
title Agent Arena
cd /d "%~dp0"

rem ---- Check the folder was extracted from the ZIP ----
if not exist src\server.js (
  echo.
  echo  ============================================================
  echo   It looks like you opened this file from INSIDE the ZIP.
  echo   Close this, right-click the ZIP and choose "Extract All...".
  echo   Then open START-Windows.bat from inside the extracted folder.
  echo  ============================================================
  echo.
  pause
  exit /b 1
)

rem ---- Find Node.js (even if Windows has not refreshed the PATH yet) ----
where node >nul 2>nul
if not errorlevel 1 goto nodeok

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"

where node >nul 2>nul
if not errorlevel 1 goto nodeok

echo.
echo  ============================================================
echo   Node.js was not found on this computer.
echo   1. Download and install it from:  https://nodejs.org  (green LTS button)
echo   2. RESTART the computer after installing
echo   3. Open this file again
echo  ============================================================
echo.
pause
exit /b 1

:nodeok
for /f "delims=" %%v in ('node -v') do echo Node.js found: %%v

if exist node_modules goto deps_ok
echo.
echo Installing components for the first time... this takes 1-3 minutes.
echo (progress is saved to the start-log.txt file)
call npm install > start-log.txt 2>&1
if errorlevel 1 (
  echo.
  echo  Failed to install components. Check your internet connection.
  echo  Error details are in the file: start-log.txt
  echo.
  pause
  exit /b 1
)

:deps_ok
echo.
echo Starting the arena... the browser will open by itself shortly.
echo (keep this window open while watching)
echo.
node src\server.js
echo.
echo The arena was closed.
pause
