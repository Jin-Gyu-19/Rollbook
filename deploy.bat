@echo off
REM ═══════════════════════════════════════════════════════════
REM  Rollbook 배포 실행파일 (Cloudflare)
REM  더블클릭 한 번으로 인터넷에 배포합니다.
REM  배포가 끝나면 나오는 주소(https://rollbook....workers.dev)를
REM  여러 PC 에서 열기만 하면 같은 출석부를 함께 사용합니다.
REM  필요한 것: Node.js + Cloudflare 계정(무료, 첫 실행 때 로그인 창)
REM ═══════════════════════════════════════════════════════════
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ┌──────────────────────────────────────┐
echo  │     Rollbook — Cloudflare 배포        │
echo  └──────────────────────────────────────┘
echo.

where npm >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\r\nodejs\r\npm.cmd" (
    set "PATH=%ProgramFiles%\r\nodejs;%PATH%"
  ) else (
    echo  [오류] Node.js 가 필요합니다. update.bat 을 먼저 실행해 주세요.
    pause
    exit /b 1
  )
)

echo  필요한 구성 요소를 확인하는 중...
call npm install --no-audit --no-fund >nul 2>nul

REM ── Cloudflare 로그인 확인 ────────────────────────────────
call npx wrangler whoami >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Cloudflare 로그인이 필요합니다. 브라우저 창이 열리면 로그인 후 허용을 눌러 주세요.
  echo  (계정이 없다면 무료로 가입할 수 있습니다)
  call npx wrangler login
  call npx wrangler whoami >nul 2>nul
  if errorlevel 1 (
    echo  [오류] 로그인에 실패했습니다. 다시 실행해 주세요.
    pause
    exit /b 1
  )
)

REM ── D1 데이터베이스 준비 (이미 있으면 그대로 사용) ────────
echo  데이터베이스를 준비하는 중...
call npx wrangler d1 create rollbook-db >nul 2>nul

set "DBID="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$d = npx wrangler d1 list --json | ConvertFrom-Json | Where-Object { $_.name -eq 'rollbook-db' } | Select-Object -First 1; if ($d.uuid) { $d.uuid } elseif ($d.database_id) { $d.database_id }"`) do set "DBID=%%i"
if not defined DBID (
  echo  [오류] 데이터베이스 정보를 가져오지 못했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
  pause
  exit /b 1
)
powershell -NoProfile -Command "(Get-Content wrangler.jsonc -Raw) -replace '\"database_id\"\s*:\s*\"[^\"]*\"', '\"database_id\": \"%DBID%\"' | Set-Content wrangler.jsonc -Encoding UTF8"

REM ── 표 만들기 (마이그레이션) ──────────────────────────────
REM  실패해도 서버가 처음 켜질 때 표를 알아서 만들기 때문에 계속 진행한다.
echo  표를 준비하는 중...
call npx wrangler d1 migrations apply rollbook-db --remote >nul 2>nul

REM ── 배포 ──────────────────────────────────────────────────
echo  배포하는 중... (1~2분 걸릴 수 있습니다)
set "URL="
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$out = npx wrangler deploy 2>&1 | Out-String; $m = [regex]::Match($out, 'https://[^\s]+workers\.dev'); if ($m.Success) { $m.Value }"`) do set "URL=%%u"

REM wrangler.jsonc 를 원래대로 되돌려 update.bat 과 충돌하지 않게 한다
git checkout -- wrangler.jsonc >nul 2>nul

if defined URL (
  echo.
  echo  ┌──────────────────────────────────────────────────────
  echo  │  [완료] 배포되었습니다!
  echo  │  주소: %URL%
  echo  │
  echo  │  · 이 주소를 여러 PC 에서 열면 같은 출석부를 함께 사용합니다
  echo  │  · 출석 체크 화면: %URL%
  echo  │  · 관리자 화면   : %URL%/admin
  echo  └──────────────────────────────────────────────────────
  echo.
  start "" %URL%/admin
) else (
  echo.
  echo  [오류] 배포 결과 주소를 확인하지 못했습니다.
  echo  아래 명령을 직접 실행해 오류 내용을 확인해 주세요:
  echo    npx wrangler deploy
)
echo.
pause
exit /b 0
