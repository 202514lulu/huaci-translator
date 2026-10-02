@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo.
echo   ==========================================
echo      划词翻译  -  自测
echo   ==========================================
echo.
echo   依次检查：取词组件、翻译引擎（三条样例）
echo.
node_modules\electron\dist\electron.exe . --selftest
echo.
echo   全部列出即为正常。按任意键关闭本窗口。
pause >nul
