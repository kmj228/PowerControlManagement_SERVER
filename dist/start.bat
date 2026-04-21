@echo off
chcp 65001 > nul
title IoT Device Manager Server

echo ===================================
echo   IoT 장비 관리 서버
echo ===================================
echo.

:: EXE 버전 확인
if exist "%~dp0DeviceManager.exe" (
    echo EXE 버전으로 실행합니다...
    start "" "%~dp0DeviceManager.exe"
    echo 서버가 실행되었습니다.
    echo 브라우저에서 https://localhost:3000 으로 접속하세요.
    pause
    exit /b 0
)

:: Node.js 설치 확인
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo.
    echo Node.js를 설치한 후 다시 실행해주세요:
    echo   https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 의존성 확인
if not exist "%~dp0node_modules" (
    echo [안내] 첫 실행입니다. 의존성 패키지를 설치합니다...
    echo.
    cd /d "%~dp0"
    npm install
    echo.
)

:: 서버 시작
echo 서버를 시작합니다...
echo 브라우저에서 https://localhost:3000 으로 접속하세요.
echo 종료하려면 Ctrl+C 를 누르세요.
echo.
cd /d "%~dp0"
node server.js
pause
