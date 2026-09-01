@echo off
REM ===========================================================
REM  Rollbook 로그인 초기화
REM  QR 과 비상 복구 코드를 모두 잃어버렸을 때 쓰는 파일입니다.
REM  로그인 정보만 지우고, 출석 기록과 명단은 그대로 둡니다.
REM  초기화 후 로그인 화면에서 가지고 계신 QR 을 비추면 다시 등록됩니다.
REM ===========================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "SITE=http://localhost:8787"

echo.
echo  +--------------------------------------+
echo  ^|      Rollbook - 로그인 초기화         ^|
echo  +--------------------------------------+
echo.
echo  QR 과 복구 코드를 모두 잃어버렸을 때만 사용하세요.
echo  출석 기록과 명단은 지워지지 않습니다.
echo.
set /p OK="  초기화할까요? (Y 를 누르고 Enter): "
if /i not "%OK%"=="Y" (
  echo.
  echo  취소했습니다.
  pause
  exit /b 0
)

echo.
echo  서버를 확인하는 중...
call :probe
if errorlevel 1 (
  echo.
  echo  [안내] 서버가 꺼져 있습니다. update.bat 을 먼저 실행해서
  echo         화면이 뜬 뒤에 이 파일을 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

echo  초기화하는 중...
curl -s -X POST -H "content-type: application/json" -d "{}" %SITE%/api/auth/local-reset > "%TEMP%\rollbook-reset.txt" 2>nul
findstr /C:"\"ok\":true" "%TEMP%\rollbook-reset.txt" >nul
if errorlevel 1 (
  echo.
  echo  [오류] 초기화하지 못했습니다. 아래 내용을 확인해 주세요.
  type "%TEMP%\rollbook-reset.txt"
  echo.
  pause
  exit /b 1
)

echo.
echo  초기화가 끝났습니다.
echo.
echo  이제 브라우저에서 %SITE%/login 을 열고
echo  가지고 계신 관리자 QR 을 카메라에 비춰 주세요.
echo  (QR 이 없으면 화면 아래 "새로 발급받기" 를 누르시면 됩니다)
echo.
start "" %SITE%/login
pause
exit /b 0

:probe
curl -s -o nul -m 3 %SITE%/api/auth/state 2>nul
exit /b %errorlevel%
