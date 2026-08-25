@echo off
REM ═══════════════════════════════════════════════════════════
REM  Rollbook 실행파일
REM  더블클릭 한 번으로: 최신 파일 받기 → 서버 시작 → 브라우저 열기
REM  필요한 것: Git + Node.js LTS (없으면 자동 설치 시도)
REM ═══════════════════════════════════════════════════════════
chcp 65001 >nul

REM 자신이 업데이트로 덮어써져도 안전하도록 임시 복사본에서 재실행
if /i not "%~1"=="--relaunched" (
  copy /y "%~f0" "%TEMP%\rollbook-update.bat" >nul
  call "%TEMP%\rollbook-update.bat" --relaunched "%~dp0"
  exit /b %errorlevel%
)

setlocal enabledelayedexpansion
set "WORKDIR=%~2"
set "REPO_URL=https://github.com/Jin-Gyu-19/Rollbook.git"
set "BRANCH=claude/qr-attendance-system-diehqy"
set "SITE=http://localhost:8787"

cd /d "%WORKDIR%"
echo.
echo  ┌──────────────────────────────────────┐
echo  │       Rollbook — 업데이트 + 실행      │
echo  └──────────────────────────────────────┘
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  [오류] Git 이 필요합니다: https://git-scm.com/download/win
  start "" https://git-scm.com/download/win
  pause
  exit /b 1
)

if exist ".git" goto update

echo  처음 실행: 전체 파일을 내려받습니다...
git init >nul 2>nul
git remote add origin "%REPO_URL%" 2>nul
git fetch --depth 1 origin "%BRANCH%"
if errorlevel 1 goto fetchfail
git checkout -f -B "%BRANCH%" "origin/%BRANCH%"
if errorlevel 1 goto fetchfail
echo  [완료] 내려받았습니다.
goto serve

:update
echo  최신 버전 확인 중...
git fetch origin "%BRANCH%"
if errorlevel 1 goto fetchfail
git reset --hard "origin/%BRANCH%" >nul
git log -1 --format="  최신 변경: %%s"

:serve
REM 서버가 이미 켜져 있으면 브라우저만 열고 끝
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%SITE%/api/status'; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo  서버가 이미 실행 중입니다. 브라우저를 엽니다.
  start "" %SITE%
  timeout /t 2 /nobreak >nul
  exit /b 0
)

where npm >nul 2>nul
if not errorlevel 1 goto npmok
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto npmok
)

echo  [안내] 서버 실행에 필요한 Node.js 를 자동 설치합니다... (확인 창이 뜨면 "예")
where winget >nul 2>nul
if errorlevel 1 goto nodemanual
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto npmok
)
echo  설치가 끝났습니다. 이 창을 닫고 update.bat 을 한 번 더 실행해 주세요.
pause
exit /b 0

:nodemanual
echo  브라우저에서 Node.js 페이지를 엽니다. LTS 설치 후 다시 실행해 주세요.
start "" https://nodejs.org/ko
pause
exit /b 0

:npmok
if not exist "node_modules\.bin\wrangler.cmd" (
  echo  구성 요소 설치 중... (최초 1회만)
  call npm install --no-audit --no-fund >nul 2>nul
)

REM 서버가 뜨면 브라우저를 여는 숨김 작업 (별도 창 없음)
echo $ok=$false; for($i=0;$i -lt 180;$i++) { try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%SITE%/api/status'; $ok=$true; break } catch { Start-Sleep -Seconds 1 } }; if($ok) { Start-Process '%SITE%' }> "%TEMP%\rollbook-open.ps1"
powershell -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',\"$env:TEMP\rollbook-open.ps1\""

echo.
echo  서버를 시작합니다. 잠시 후 브라우저가 자동으로 열립니다.
echo   - 출석 체크: %SITE%   ·  관리자: %SITE%/admin
echo   - 종료: 이 창을 닫거나 Ctrl+C
echo.
call npx wrangler dev --port 8787
pause
exit /b 0

:fetchfail
echo.
echo  [오류] 클라우드에서 파일을 받아오지 못했습니다.
echo   - 인터넷 연결을 확인해 주세요.
echo   - 저장소가 비공개라면 GitHub 로그인 창이 떠야 정상입니다.
echo.
pause
exit /b 1
