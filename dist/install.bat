@echo off
chcp 65001 > nul
title 의존성 패키지 설치

echo ===================================
echo   의존성 패키지 설치
echo ===================================
echo.

:: Node.js 설치 확인
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo Node.js를 설치한 후 다시 실행해주세요: https://nodejs.org
    pause
    exit /b 1
)

cd /d "%~dp0"
echo npm 패키지 설치 중...
npm install

if %errorlevel% equ 0 (
    echo.
    echo 설치가 완료되었습니다!
    echo start.bat 을 실행하여 서버를 시작하세요.
) else (
    echo.
    echo [오류] 설치 중 오류가 발생했습니다.
)

pause
