@echo off
chcp 65001 > nul
echo ===================================
echo   배포 패키지 생성 (EXE 빌드)
echo ===================================
echo.

:: Node.js 설치 확인
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 설치 후 다시 실행해주세요.
    pause
    exit /b 1
)

:: source 폴더 확인
if not exist "%~dp0source\server.js" (
    echo [오류] source\server.js 를 찾을 수 없습니다.
    pause
    exit /b 1
)

:: dist 폴더 생성
if not exist "%~dp0dist" mkdir "%~dp0dist"

:: 패키지 설치 및 EXE 빌드
echo 패키지 설치 및 EXE 빌드 중... (수 분 소요될 수 있습니다)
pushd "%~dp0source"
call npm install
call npm run build
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
echo.
pause
