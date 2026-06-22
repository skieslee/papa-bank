@echo off
REM ============================================
REM  Deploy papa-bank to Firebase Hosting
REM  Just double-click this file to deploy.
REM  (.cmd is not blocked by PowerShell script policy)
REM ============================================
cd /d "%~dp0"

echo.
echo  Deploying papa-bank to Firebase Hosting...
echo  ------------------------------------------
call firebase deploy --only hosting

echo.
if errorlevel 1 (
  echo  [FAILED] If it asks you to log in first, run:  firebase login
) else (
  echo  [OK] Deploy complete. The Hosting URL shown above is your site.
)
echo.
echo  Press any key to close...
pause >nul
