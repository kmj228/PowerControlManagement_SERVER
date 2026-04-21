@echo off
chcp 65001 > nul
title IoT Device Manager Server

echo ===================================
echo   IoT 장비 관리 서버
echo ===================================
echo.

:: Node.js 설치 확인
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [안내] Node.js가 설치되어 있지 않습니다. 자동으로 설치합니다...
    echo.

    :: winget 사용 가능 여부 확인 (Windows 10/11)
    winget --version > nul 2>&1
    if %errorlevel% equ 0 (
        echo winget으로 Node.js LTS를 설치합니다...
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    ) else (
        :: PowerShell로 MSI 다운로드 후 설치
        echo Node.js LTS를 다운로드합니다. 잠시 기다려주세요...
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi' -OutFile '%TEMP%\node_installer.msi'"
        echo 설치 중...
        msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
        del "%TEMP%\node_installer.msi" > nul 2>&1
    )

    :: 설치 후 PATH에 Node.js 추가 (현재 세션 반영)
    set "PATH=C:\Program Files\nodejs;%PATH%"

    :: 재확인
    node --version > nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo [안내] 설치가 완료되었습니다.
        echo 이 창을 닫고 start.bat 을 다시 실행해주세요.
        pause
        exit /b 0
    )
    echo Node.js 설치 완료!
    echo.
)

:: 의존성 확인
if not exist "%~dp0node_modules" (
    echo 의존성 패키지를 설치합니다...
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
