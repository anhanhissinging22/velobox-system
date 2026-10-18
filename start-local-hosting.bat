@echo off
setlocal
cd /d "%~dp0"
set HOST=0.0.0.0
node server.mjs
pause
