@echo off
REM ============================================
REM  一鍵部署 papa-bank 到 Firebase Hosting
REM  直接雙擊這個檔案即可（用 .cmd 不受 PowerShell 指令碼政策限制）
REM ============================================
cd /d "%~dp0"

echo.
echo  Deploying papa-bank to Firebase Hosting...
echo  ------------------------------------------
call firebase deploy --only hosting

echo.
if errorlevel 1 (
  echo  X  部署失敗。若顯示需要登入，請先執行:  firebase login
) else (
  echo  V  部署完成！上面那行 Hosting URL 就是你的網址。
)
echo.
echo  按任意鍵關閉視窗...
pause >nul
