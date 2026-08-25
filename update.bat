@echo off
REM ═══════════════════════════════════════════════════════════
REM  Rollbook 실행파일
REM  더블클릭 한 번으로:
REM   1) 클라우드(GitHub)의 최신 파일 다운로드/갱신
REM   2) 로컬 서버 자동 시작
REM   3) 브라우저에서 사이트 자동 열기 (http://localhost:8787)
REM  필요한 것: Git + Node.js LTS
REM ═══════════════════════════════════════════════════════════
chcp 65001 >nul

REM 브라우저 오프너 모드: 서버가 응답할 때까지 기다렸다가 사이트를 연다
if /i "%~1"=="--open" goto opener

REM 이 파일 자신도 업데이트로 덮어써질 수 있으므로, 임시 복사본에서 재실행
if /i not "%~1"=="--relaunched" (
  copy /y "%~f0" "%TEMP%\rollbook-update.bat" >nul
  call "%TEMP%\rollbook-update.bat" --relaunched "%~dp0"
  exit /b %errorlevel%
)

setlocal enabledelayedexpansion
set "WORKDIR=%~2"
set "REPO_URL=https://github.com/Jin-Gyu-19/Rollbook.git"
set "BRANCH=claude/qr-attendance-system-diehqy"

cd /d "%WORKDIR%"
echo.
echo  ┌──────────────────────────────────────┐
echo  │       Rollbook — 업데이트 + 실행      │
echo  └──────────────────────────────────────┘
echo   폴더   : %WORKDIR%
echo   브랜치 : %BRANCH%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  [오류] Git 이 설치되어 있지 않습니다.
  echo         https://git-scm.com/download/win 에서 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

if exist ".git" goto update

REM ── 처음 실행: 전체 다운로드 ──────────────────────────────
echo  처음 실행입니다. 전체 파일을 내려받습니다...
git init >nul 2>nul
git remote add origin "%REPO_URL%" 2>nul
git fetch origin "%BRANCH%"
if errorlevel 1 goto fetchfail
git checkout -f -B "%BRANCH%" "origin/%BRANCH%"
if errorlevel 1 goto fetchfail
echo.
echo  [완료] 전체 파일을 내려받았습니다.
goto serve

REM ── 이후 실행: 갱신 ───────────────────────────────────────
:update
echo  최신 버전을 확인하는 중...
git fetch origin "%BRANCH%"
if errorlevel 1 goto fetchfail

REM 로컬에서 직접 고친 파일이 있으면 덮어쓰기 전에 확인
set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain 2^>nul') do set "DIRTY=1"
if defined DIRTY (
  echo.
  echo  [주의] 이 폴더에서 직접 수정한 파일이 있습니다.
  echo         계속하면 클라우드 버전으로 덮어써져 수정 내용이 사라집니다.
  choice /c YN /m "  그래도 계속할까요? (Y=덮어쓰기 / N=취소)"
  if errorlevel 2 (
    echo  취소했습니다. 아무것도 바꾸지 않았습니다.
    pause
    exit /b 0
  )
)

git reset --hard "origin/%BRANCH%" >nul
if errorlevel 1 goto fetchfail
echo.
echo  [완료] 최신 버전으로 업데이트되었습니다.
git log -1 --format="  최신 변경: %%s (%%cd)" --date=format:"%%Y-%%m-%%d %%H:%%M"

REM ── 서버 자동 시작 + 브라우저 자동 열기 ───────────────────
:serve
echo.
where npm >nul 2>nul
if not errorlevel 1 goto npmok

REM 설치는 됐지만 PATH 에 아직 안 잡힌 경우 (설치 직후)
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto npmok
)

echo  [안내] 서버 실행에 필요한 Node.js 가 아직 설치되어 있지 않습니다.
choice /c YN /m "  지금 자동으로 설치할까요? (Y=자동 설치 / N=직접 설치)"
if errorlevel 2 goto nodemanual

where winget >nul 2>nul
if errorlevel 1 goto nodemanual

echo.
echo  Node.js LTS 를 설치하는 중입니다... (관리자 확인 창이 뜨면 "예"를 눌러 주세요)
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  echo  [완료] Node.js 설치가 끝났습니다.
  goto npmok
)
echo.
echo  [안내] 설치가 끝났습니다. 이 창을 닫고 update.bat 을 한 번 더 실행해 주세요.
pause
exit /b 0

:nodemanual
echo.
echo  브라우저에서 Node.js 다운로드 페이지를 엽니다.
echo  LTS 버전을 설치한 뒤 update.bat 을 다시 실행해 주세요.
start "" https://nodejs.org/ko
pause
exit /b 0

:npmok
echo  필요한 구성 요소를 설치하는 중... (처음에는 잠시 걸릴 수 있습니다)
call npm install --no-audit --no-fund >nul 2>nul

echo.
echo  서버를 시작합니다. 잠시 후 브라우저가 자동으로 열립니다.
echo   - 출석 체크  : http://localhost:8787
echo   - 관리자     : http://localhost:8787/admin
echo   - 종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo.

REM 서버가 뜨는 것을 기다렸다가 브라우저를 여는 백그라운드 창 실행
start "" /min "%TEMP%\rollbook-update.bat" --open

call npx wrangler dev
pause
exit /b 0

REM ── 오프너: 서버 응답 대기 후 브라우저 열기 ───────────────
:opener
where curl >nul 2>nul
if errorlevel 1 (
  timeout /t 8 /nobreak >nul
  start "" http://localhost:8787
  exit /b 0
)
for /l %%i in (1,1,90) do (
  curl -s -o nul http://localhost:8787/api/status 2>nul
  if not errorlevel 1 (
    start "" http://localhost:8787
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 0

:fetchfail
echo.
echo  [오류] 클라우드에서 파일을 받아오지 못했습니다.
echo   - 인터넷 연결을 확인해 주세요.
echo   - 저장소가 비공개라면 GitHub 로그인 창이 떠야 정상입니다.
echo     (Git 설치 시 Git Credential Manager 를 함께 설치하면 자동 처리됩니다)
echo.
pause
exit /b 1
