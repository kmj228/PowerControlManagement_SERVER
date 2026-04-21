@echo off
chcp 65001 > nul
pause

echo [1] Node.js 확인 중...
node --version
if %errorlevel% neq 0 (
    echo [오류] Node.js 없음
    pause
    exit /b 1
)
echo Node.js OK
pause

echo [2] pkg 확인 중...
pkg --version
if %errorlevel% neq 0 (
    echo pkg 없음, 설치 중...
    npm install -g pkg
    if %errorlevel% neq 0 (
        echo [오류] pkg 설치 실패
        pause
        exit /b 1
    )
)
echo pkg OK
pause

echo [3] source\server.js 확인 중...
if not exist "%~dp0source\server.js" (
    echo [오류] source\server.js 없음
    pause
    exit /b 1
)
echo server.js OK
pause

echo [4] dist 폴더 생성 중...
if not exist "%~dp0dist" mkdir "%~dp0dist"
echo dist OK
pause

echo [5] EXE 빌드 중...
pushd "%~dp0source"
pkg . --targets node18-win-x64 --output "%~dp0dist\DeviceManager.exe" --compress GZip
set BUILD_RESULT=%errorlevel%
popd

if %BUILD_RESULT% neq 0 (
    echo [오류] 빌드 실패
    pause
    exit /b 1
)

echo.
echo 완료! dist\ 폴더를 사용자에게 전달하세요.
pause
