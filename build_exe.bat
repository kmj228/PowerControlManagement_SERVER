@echo off
chcp 65001 > nul
echo ===================================
echo   EXE 빌드 (독립 실행 파일)
echo ===================================
echo.

:: pkg 설치 확인
pkg --version > nul 2>&1
if %errorlevel% neq 0 (
    echo pkg 가 설치되어 있지 않습니다. 설치 중...
    npm install -g pkg
    echo.
)

:: 빌드
cd /d "%~dp0source"
echo 빌드 중... (수 분 소요될 수 있습니다)
npm run build

if %errorlevel% equ 0 (
    echo.
    echo 빌드 완료!
    echo dist\DeviceManager.exe 가 생성되었습니다.
    echo.
    echo 배포 방법:
    echo   dist\DeviceManager.exe 와 dist\start.bat 을 함께 전달하세요.
    echo   사용자는 DeviceManager.exe 또는 start.bat 을 실행하면 됩니다.
    echo   (Node.js 불필요 - 독립 실행 가능)
) else (
    echo.
    echo [오류] 빌드 실패. 오류 메시지를 확인하세요.
)

cd /d "%~dp0"
pause
