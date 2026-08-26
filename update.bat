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
git --no-pager log -1 --format="  최신 변경: %%s"

:serve
REM 서버가 이미 켜져 있으면 브라우저만 열고 끝
echo  서버 상태 확인 중...
call :probe
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
  echo  구성 요소 설치 중... (최초 1회만, 1~2분)
  call npm install --no-audit --no-fund > "%TEMP%\rollbook-npm.log" 2>&1
)
if not exist "node_modules\.bin\wrangler.cmd" (
  echo.
  echo  [오류] 구성 요소 설치에 실패했습니다. 아래 로그를 캡처해서 알려주세요:
  echo  ──────────────────────────────────────
  type "%TEMP%\rollbook-npm.log"
  echo  ──────────────────────────────────────
  pause
  exit /b 1
)

echo.
echo  서버를 시작하는 중입니다... (창을 닫지 마세요)
start "" /b cmd /c "npx --yes wrangler dev --port 8787"

set /a WAITED=0
:waitsrv
if %WAITED% geq 120 goto waitfail
timeout /t 1 /nobreak >nul
call :probe
if errorlevel 1 (
  set /a WAITED+=1
  goto waitsrv
)

echo.
echo  [완료] 서버가 켜졌습니다. 브라우저를 엽니다.
start "" %SITE%
echo.
echo  ┌─────────────────────────────────────────────────┐
echo  │  실행 중 — 이 창을 닫으면 서버도 함께 꺼집니다  │
echo  └─────────────────────────────────────────────────┘
echo    출석 체크: %SITE%
echo    관리자   : %SITE%/admin
echo.
pause >nul
exit /b 0

:waitfail
echo.
echo  [오류] 2분 안에 서버가 응답하지 않았습니다.
echo  위쪽에 표시된 오류 내용을 캡처해서 알려주세요.
pause
exit /b 1

REM 서버 응답 확인 (curl 이 없으면 PowerShell 로)
:probe
where curl >nul 2>nul
if errorlevel 1 goto probe_ps
curl -s -o nul -m 2 %SITE%/api/status 2>nul
exit /b
:probe_ps
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%SITE%/api/status'; exit 0 } catch { exit 1 }" >nul 2>nul
exit /b

:fetchfail
echo.
echo  [오류] 클라우드에서 파일을 받아오지 못했습니다.
echo   - 인터넷 연결을 확인해 주세요.
echo   - 저장소가 비공개라면 GitHub 로그인 창이 떠야 정상입니다.
echo.
pause
exit /b 1
