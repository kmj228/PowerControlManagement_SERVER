@echo off
chcp 65001 > nul
echo ===================================
echo   배포 패키지 생성 (EXE 빌드)
echo ===================================
echo.

:: 배트 파일 위치를 기준으로 경로 설정
set ROOT=%~dp0
set SOURCE=%~dp0source
set DIST=%~dp0dist

:: source 폴더 확인
if not exist "%SOURCE%\server.js" (
    echo [오류] source\server.js 를 찾을 수 없습니다.
    echo make_dist.bat 과 source\ 폴더가 같은 위치에 있어야 합니다.
    echo.
    pause
    exit /b 1
)

:: Node.js 설치 확인
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 설치 후 다시 실행해주세요.
    echo.
    pause
    exit /b 1
)

:: pkg 설치 확인
pkg --version > nul 2>&1
if %errorlevel% neq 0 (
    echo pkg 가 설치되어 있지 않습니다. 설치 중...
    npm install -g pkg
    if %errorlevel% neq 0 (
        echo [오류] pkg 설치에 실패했습니다.
        pause
        exit /b 1
    )
    echo.
)

:: dist 폴더 생성 및 기존 소스 파일 정리
if not exist "%DIST%" mkdir "%DIST%"
if exist "%DIST%\server.js"    del /Q "%DIST%\server.js"
if exist "%DIST%\index.html"   del /Q "%DIST%\index.html"
if exist "%DIST%\app.js"       del /Q "%DIST%\app.js"
if exist "%DIST%\package.json" del /Q "%DIST%\package.json"
if exist "%DIST%\logo_ci.png"  del /Q "%DIST%\logo_ci.png"
if exist "%DIST%\logo_bl.png"  del /Q "%DIST%\logo_bl.png"
if exist "%DIST%\node_modules" rd /S /Q "%DIST%\node_modules"

:: EXE 빌드
echo EXE 빌드 중... (수 분 소요될 수 있습니다)
pushd "%SOURCE%"
pkg . --targets node18-win-x64 --output "%DIST%\DeviceManager.exe" --compress GZip
set BUILD_RESULT=%errorlevel%
popd

if %BUILD_RESULT% neq 0 (
    echo.
    echo [오류] 빌드에 실패했습니다.
    pause
    exit /b 1
)

echo.
echo 완료!
echo dist\ 폴더를 사용자에게 전달하세요.
echo 사용자는 dist\start.bat 을 실행하면 됩니다. (Node.js 불필요)
echo.
pause
