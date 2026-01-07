@echo off
title VDS Makro Agent - Baslatiliyor...
echo ========================================
echo       VDS MAKRO AGENT BASLATICI
echo ========================================

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js yuklu degil! Lutfen once Node.js kurun.
    pause
    exit /b
)

:: Check for node_modules
if not exist "node_modules" (
    echo [BILGI] Bagimliliklar eksik, npm install calistiriliyor...
    call npm install
)

:: Start the agent
echo [BILGI] Ajan baslatiliyor...
node src/index.js

if %errorlevel% neq 0 (
    echo [HATA] Uygulama beklenmedik bir sekilde sonlandi.
    pause
)
