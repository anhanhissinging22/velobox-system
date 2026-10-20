@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [VELOBOX] Dang kiem tra Node.js...
set "NODE_CMD=node"
where node >nul 2>&1
if errorlevel 1 (
    if exist "C:\Users\admin\AppData\Local\OpenAI\Codex\runtimes\cua_node\78fb63cda1a9e2b2\bin\node.exe" (
        set "NODE_CMD=C:\Users\admin\AppData\Local\OpenAI\Codex\runtimes\cua_node\78fb63cda1a9e2b2\bin\node.exe"
    ) else if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else (
        echo [LOI] Khong tim thay Node.js tren may!
        pause
        exit /b 1
    )
)

set HOST=0.0.0.0
set PORT=4173
echo [VELOBOX] Khoi dong server tai cong %PORT%...
"%NODE_CMD%" server.mjs
pause

