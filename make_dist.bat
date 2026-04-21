@echo off
chcp 65001 > nul
echo ===================================
echo   배포 패키지 생성 (EXE 빌드)
echo ===================================
echo.

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

:: dist 폴더 생성
if not exist dist mkdir dist

:: 기존 소스 파일 정리 (이전에 복사된 파일이 있을 경우)
if exist dist\server.js   del /Q dist\server.js
if exist dist\index.html  del /Q dist\index.html
if exist dist\app.js      del /Q dist\app.js
if exist dist\package.json del /Q dist\package.json
if exist dist\logo_ci.png del /Q dist\logo_ci.png
if exist dist\logo_bl.png del /Q dist\logo_bl.png
if exist dist\node_modules rd /S /Q dist\node_modules

:: EXE 빌드
echo EXE 빌드 중... (수 분 소요될 수 있습니다)
cd source
pkg . --targets node18-win-x64 --output ..\dist\DeviceManager.exe --compress GZip
cd ..

if %errorlevel% neq 0 (
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
