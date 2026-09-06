@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 清框影 Web 版...
call npm start
if errorlevel 1 (
  echo.
  echo 启动失败,请确认已执行过 npm install
  pause
)
