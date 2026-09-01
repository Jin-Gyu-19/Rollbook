# Rollbook — QR 출석부

QR 코드로 출석을 체크하는 출석부 시스템입니다. Cloudflare Workers 에서 동작하고 데이터는 Cloudflare D1 에 저장됩니다. UI 는 BDO 클린 인디고 디자인 가이드를 따릅니다.

## 화면

| 경로 | 설명 |
|---|---|
| `/login` | **로그인** — 카메라에 로그인 QR 을 비추거나, 등록해 둔 관리자 비밀번호로 들어갑니다. |
| `/` | **출석 체크 (스캐너)** — 카메라가 상시 켜져 있고, 개인 QR 을 비추면 출석 처리됩니다. 인식되면 "○○○님 출석이 완료되었습니다" 모달이 뜨고 약 1초 뒤 자동으로 닫힙니다. |
| `/admin` | **관리자** — 출석부 작성·수정·삭제·사용 지정, 출석 현황(출석률·수동 편집), 명단 관리, 로고 삽입 QR 코드 생성·다운로드 |

## 동작 방식

1. **명단** 탭에서 인원을 추가하면 개인 QR 코드 값(`RB-XXXX-XXXX`)이 자동 발급됩니다.
2. **QR 코드** 탭에서 디자인(점 모양·색상·회사 로고)을 입혀 PNG 로 내려받아 배포합니다.
   - 오류 보정 레벨 H(30%) 로 생성하므로 가운데 로고(면적 35%)를 넣어도 인식에 문제가 없습니다.
3. **출석부** 탭에서 출석부를 만들고 "사용" 으로 지정하면, 스캐너가 그 출석부에 기록합니다.
4. 스캐너(`/`)를 켜 둔 기기에 QR 을 비추면 출석 완료 — 중복 스캔은 "이미 출석 처리되었습니다" 로 안내합니다.
5. **출석 현황** 탭에서 출석/미출석과 시각을 보고, 수동으로 출석 처리·취소(편집)할 수 있습니다.

## 내 PC로 받아서 테스트하기 (`update.bat`)

Windows 에서 `update.bat` 을 더블클릭하면 클라우드(GitHub)의 최신 파일을 그 폴더로 받아옵니다.

- **처음 실행**: 전체 파일을 새로 다운로드
- **이후 실행**: 바뀐 파일은 갱신, 새 파일은 다운로드 (로컬에서 직접 수정한 파일이 있으면 덮어쓰기 전에 물어봅니다)
- 끝나면 로컬 테스트 서버(`npm run dev`, http://localhost:8787) 실행 여부를 물어봅니다

준비물: [Git](https://git-scm.com/download/win) (비공개 저장소는 첫 실행 때 GitHub 로그인 창이 뜹니다), 서버 실행까지 하려면 [Node.js LTS](https://nodejs.org).

처음 받을 때는 GitHub 에서 `update.bat` 파일 하나만 내려받아 원하는 폴더에 두고 실행하면 됩니다.

## 여러 PC 에서 함께 쓰기 (`deploy.bat`)

`update.bat` 로 실행하는 로컬 서버는 **PC마다 데이터가 따로** 저장되는 테스트용입니다.
여러 PC 에서 같은 출석부를 함께 쓰려면 `deploy.bat` 을 더블클릭해 Cloudflare 에 배포하세요.

- Cloudflare 계정(무료)으로 로그인 → D1 생성 → 배포까지 자동으로 진행됩니다
- 끝나면 나오는 주소(`https://rollbook.<계정>.workers.dev`)를 **각 PC 브라우저에서 열기만 하면** 됩니다 — 설치 불필요, HTTPS 라 카메라도 바로 동작
- 코드를 수정한 뒤 다시 `deploy.bat` 을 실행하면 같은 주소로 갱신됩니다 (아래 자동 배포를 설정하면 이 과정도 생략됩니다)

## 배포 (수동, CLI)

```bash
npm install
npx wrangler login

# 1) D1 데이터베이스 생성 → 출력된 database_id 를 wrangler.jsonc 에 붙여넣기
npm run db:create

# 2) 스키마 적용 (Worker 가 자동 생성하므로 생략 가능)
npm run db:migrate        # 원격(프로덕션)
npm run db:migrate:local  # 로컬 개발용

# 3) 배포
npm run deploy
```

로컬 개발은 `npm run dev` (http://localhost:8787). 카메라는 HTTPS 또는 localhost 에서만 동작합니다 — `*.workers.dev` 는 HTTPS 라서 문제 없습니다.

> 테이블은 Worker 가 최초 요청 시 자동 생성(`CREATE TABLE IF NOT EXISTS`)하기도 하므로, 마이그레이션을 건너뛰어도 동작은 합니다.

## 서체 (선택)

디자인 가이드 서체인 Pretendard 를 쓰려면 `PretendardVariable.woff2` 파일을 `public/` 에 넣으면 됩니다. 없으면 Apple SD Gothic Neo → Malgun Gothic 순으로 대체됩니다.

## 로그인 / 접근 권한

모든 화면과 API 는 로그인해야 열립니다. 로그인 방법은 두 가지입니다.

- **로그인 QR** — 관리자용 QR 과 스캐너 PC 용 QR 이 따로 있습니다. 출석용 명찰 QR 과는 값이 완전히 달라서, 명찰이 노출돼도 로그인에는 쓸 수 없습니다.
- **관리자 비밀번호** — 첫 설정 화면이나 관리자 › 보안 탭에서 정합니다. 정해 두면 로그인 화면에 "비밀번호로 로그인" 이 나타납니다.

권한은 두 종류입니다.

| 권한 | 들어갈 수 있는 곳 | 세션 유지 |
|---|---|---|
| 관리자 | 관리 화면 전체 + 출석 촬영 화면 | 30일 |
| 스캐너 PC | 출석 촬영 화면만 | 1년 |

- **첫 실행**: 로그인 화면에서 이미 가진 관리자 QR 을 비추면 그 QR 이 이 시스템에 등록되고, QR 이 없으면 새로 발급받습니다. 이때 나오는 **비상 복구 코드는 그 화면에서만** 보이므로 반드시 따로 적어 두세요.
- **실패 잠금**: 로그인에 5회 실패하면 10분간 잠깁니다. 관리자는 보안 탭에서 즉시 풀 수 있습니다. 출석용 QR 을 잘못 비춘 것은 실패로 세지 않습니다.
- **비밀번호·복구 코드**는 PBKDF2-SHA256 해시로만 저장되어 다시 볼 수 없습니다.
- **QR 과 복구 코드를 모두 잃어버렸을 때**는 그 PC 에서 `로그인초기화.bat` 을 실행하면 로그인 정보만 초기화됩니다(출석 기록·명단은 보존). 배포된 주소나 다른 PC 에서는 동작하지 않습니다.

## 자동 배포 (GitHub Actions)

저장소 Settings → Secrets and variables → Actions 에 `CLOUDFLARE_API_TOKEN` 을 등록해 두면, 코드가 올라갈 때마다 Cloudflare 에 자동으로 배포됩니다(`.github/workflows/deploy.yml`). 데이터베이스 확인·마이그레이션·배포까지 한 번에 진행되며, 토큰이 없으면 아무 것도 하지 않고 조용히 끝납니다.

## 기술 스택

- Cloudflare Workers (정적 자산 + API) · D1 (SQLite)
- 스캔: `BarcodeDetector` API (지원 시) → [jsQR](https://github.com/cozmo/jsQR) 폴백 — `public/vendor/jsqr.js`
- QR 생성: [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) — 점 모양·색상·로고 삽입 — `public/vendor/qr-code-styling.js`
- 디자인: `public/bdo-design.css` (BDO 클린 인디고 v1) + `public/app.css`
