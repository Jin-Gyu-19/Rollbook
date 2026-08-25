@echo off
REM ═══════════════════════════════════════════════════════════
REM  Rollbook 업데이트 실행파일
REM  더블클릭하면 클라우드(GitHub)의 최신 파일을 이 폴더로 받아옵니다.
REM   - 처음 실행: 전체 다운로드
REM   - 이후 실행: 바뀐 파일 갱신 + 새 파일 다운로드
REM  필요한 것: Git (https://git-scm.com/download/win)
REM ═══════════════════════════════════════════════════════════
chcp 65001 >nul

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
echo  │   Rollbook — 클라우드 파일 업데이트   │
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
goto deps

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

REM ── 의존성 설치 + 로컬 서버 실행 안내 ─────────────────────
:deps
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo  [안내] Node.js 가 없어 로컬 서버는 실행할 수 없습니다.
  echo         테스트하려면 https://nodejs.org 에서 LTS 버전을 설치해 주세요.
  echo.
  pause
  exit /b 0
)

echo  필요한 구성 요소를 설치하는 중... (잠시 걸릴 수 있습니다)
call npm install --no-audit --no-fund >nul 2>nul

echo.
choice /c YN /m "  로컬 테스트 서버를 바로 시작할까요? (Y=시작 / N=종료)"
if errorlevel 2 (
  echo.
  echo  나중에 시작하려면 이 폴더에서 `npm run dev` 를 실행하세요.
  pause
  exit /b 0
)

echo.
echo  서버를 시작합니다 — 브라우저에서 http://localhost:8787 을 여세요.
echo  (관리자 페이지: http://localhost:8787/admin · 종료: Ctrl+C)
echo.
call npx wrangler dev
pause
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
