@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo.
echo   ==========================================
echo      划词翻译  启动中...
echo   ==========================================
echo.
echo   用法：选中任意文字，按  Alt+Shift+Z  即可翻译
echo   程序常驻右下角托盘；右键托盘图标可设置或退出
echo.
start "" "%~dp0dist\win-unpacked\划词翻译.exe"
exit
