@echo off
rem Double-click to start the QR ordering system (Windows)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install the LTS version from https://nodejs.org then run this file again.
  start "" https://nodejs.org
  pause
  exit /b
)
if not exist node_modules (
  echo First run: installing, please wait...
  call npm install
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/staff"
echo.
echo Keep this window open while the shop is open. Close it to stop the system.
echo.
node server.js
pause
