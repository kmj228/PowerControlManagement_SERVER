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

    winget --version > nul 2>&1
    if %errorlevel% equ 0 (
        echo winget으로 Node.js LTS를 설치합니다...
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    ) else (
        echo Node.js LTS를 다운로드합니다. 잠시 기다려주세요...
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi' -OutFile '%TEMP%\node_installer.msi'"
        echo 설치 중...
        msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
        del "%TEMP%\node_installer.msi" > nul 2>&1
    )

    set "PATH=C:\Program Files\nodejs;%PATH%"

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

:: MariaDB 설치 확인
set DB_FOUND=0
sc query MariaDB > nul 2>&1 && set DB_FOUND=1
if %DB_FOUND%==0 sc query MySQL > nul 2>&1 && set DB_FOUND=1
if %DB_FOUND%==0 mysql --version > nul 2>&1 && set DB_FOUND=1

if %DB_FOUND%==0 (
    echo [안내] MariaDB가 설치되어 있지 않습니다.
    echo       데이터베이스 없이도 서버는 실행되지만,
    echo       로그 저장 기능을 사용하려면 MariaDB가 필요합니다.
    echo.
    echo  [ MariaDB 설치 방법 ]
    echo   1. https://mariadb.org/download 에서 다운로드
    echo   2. 설치 중 Root 비밀번호를 설정하세요
    echo.
    echo  [ 설치 후 데이터베이스 설정 방법 ]
    echo   1. 서버 실행 후 브라우저에서 접속
    echo   2. 설정 메뉴 - 데이터베이스 설정에서 아래 정보 입력:
    echo        호스트  : localhost
    echo        포트    : 3306
    echo        아이디  : root  (또는 생성한 계정)
    echo        비밀번호: 설치 시 지정한 Root 비밀번호
    echo        DB명    : 원하는 데이터베이스 이름 입력
    echo.
    echo   * 아이디/비밀번호가 기억나지 않으면:
    echo     MariaDB를 재설치하거나 root 비밀번호를 초기화하세요.
    echo.
    pause
    echo 서버를 계속 시작합니다...
    echo.
)

:: server.js 위치 탐색 (현재 폴더 → 상위의 source 폴더 순서로 확인)
set SERVER_DIR=
if exist "%~dp0server.js" (
    set SERVER_DIR=%~dp0
) else if exist "%~dp0..\source\server.js" (
    pushd "%~dp0..\source"
    set SERVER_DIR=%CD%\
    popd
)

if not defined SERVER_DIR (
    echo [오류] server.js 파일을 찾을 수 없습니다.
    echo.
    echo start.bat 과 server.js 가 같은 폴더에 있어야 합니다.
    echo 또는 source\ 폴더 안에 server.js 가 있어야 합니다.
    echo.
    pause
    exit /b 1
)

:: 의존성 확인
if not exist "%SERVER_DIR%node_modules" (
    echo 의존성 패키지를 설치합니다...
    cd /d "%SERVER_DIR%"
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo [오류] 패키지 설치에 실패했습니다.
        pause
        exit /b 1
    )
    echo.
)

:: 서버 시작
echo 서버를 시작합니다...
echo 브라우저에서 https://localhost:3000 으로 접속하세요.
echo 종료하려면 Ctrl+C 를 누르세요.
echo.
cd /d "%SERVER_DIR%"
node server.js
pause
