@echo off
chcp 65001 > nul
echo ===================================
echo   배포 패키지 생성
echo ===================================
echo.

:: dist 폴더 생성
if not exist dist mkdir dist

:: 소스 파일 복사
echo 소스 파일 복사 중...
copy /Y source\server.js   dist\ > nul
copy /Y source\index.html  dist\ > nul
copy /Y source\app.js      dist\ > nul
copy /Y source\package.json dist\ > nul
copy /Y source\logo_ci.png dist\ > nul
copy /Y source\logo_bl.png dist\ 2>nul

echo.
echo 완료! dist\ 폴더를 사용자에게 전달하세요.
echo 사용자는 dist\start.bat 을 실행하면 됩니다.
echo.
pause
