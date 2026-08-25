# Rollbook — QR 출석부

QR 코드로 출석을 체크하는 출석부 시스템입니다. Cloudflare Workers 에서 동작하고 데이터는 Cloudflare D1 에 저장됩니다. UI 는 BDO 클린 인디고 디자인 가이드를 따릅니다.

## 화면

| 경로 | 설명 |
|---|---|
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

## 배포 (Cloudflare)

```bash
npm install
npx wrangler login

# 1) D1 데이터베이스 생성 → 출력된 database_id 를 wrangler.jsonc 에 붙여넣기
npm run db:create

# 2) 스키마 적용
npm run db:migrate        # 원격(프로덕션)
npm run db:migrate:local  # 로컬 개발용

# 3) 배포
npm run deploy
```

로컬 개발은 `npm run dev` (http://localhost:8787). 카메라는 HTTPS 또는 localhost 에서만 동작합니다 — `*.workers.dev` 는 HTTPS 라서 문제 없습니다.

> 테이블은 Worker 가 최초 요청 시 자동 생성(`CREATE TABLE IF NOT EXISTS`)하기도 하므로, 마이그레이션을 건너뛰어도 동작은 합니다.

## 서체 (선택)

디자인 가이드 서체인 Pretendard 를 쓰려면 `PretendardVariable.woff2` 파일을 `public/` 에 넣으면 됩니다. 없으면 Apple SD Gothic Neo → Malgun Gothic 순으로 대체됩니다.

## 관리자 페이지 보호 (권장)

현재 관리자 페이지에는 별도 로그인이 없습니다. 운영 시에는 Cloudflare Zero Trust → Access 에서 `<your-domain>/admin` 과 `/api/*` (checkin 제외) 경로에 접근 정책을 걸어 보호하는 것을 권장합니다.

## 기술 스택

- Cloudflare Workers (정적 자산 + API) · D1 (SQLite)
- 스캔: `BarcodeDetector` API (지원 시) → [jsQR](https://github.com/cozmo/jsQR) 폴백 — `public/vendor/jsqr.js`
- QR 생성: [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) — 점 모양·색상·로고 삽입 — `public/vendor/qr-code-styling.js`
- 디자인: `public/bdo-design.css` (BDO 클린 인디고 v1) + `public/app.css`
