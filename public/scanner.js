/* Rollbook 스캐너 — 상시 카메라 + QR 인식 → 출석 체크 */
(() => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('frame');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const offline = document.getElementById('cameraOffline');
  const offlineMsg = document.getElementById('cameraOfflineMsg');
  const btnRetry = document.getElementById('btnRetryCamera');
  const camState = document.getElementById('camState');
  const sheetBanner = document.getElementById('sheetBanner');
  const modal = document.getElementById('resultModal');
  const resultIcon = document.getElementById('resultIcon');
  const resultName = document.getElementById('resultName');
  const resultMsg = document.getElementById('resultMsg');

  const MODAL_MS = 1200;        // 인식 완료 모달: 1초 정도 후 자동 닫힘
  const SAME_CODE_COOLDOWN = 4000; // 같은 코드 연속 인식 방지
  const DECODE_INTERVAL = 160;  // 디코딩 주기(ms)

  let stream = null;
  let busy = false;             // 서버 요청/모달 표시 중에는 스캔 일시 정지
  let lastCode = '';
  let lastCodeAt = 0;
  let lastDecodeAt = 0;
  let modalTimer = null;
  let detector = null;

  if ('BarcodeDetector' in window) {
    BarcodeDetector.getSupportedFormats?.()
      .then((formats) => {
        if (formats.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
      })
      .catch(() => {});
  }

  // ── 기록 중인 출석부 배너 ────────────────────────────
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let bannerKey = null; // 같은 내용이면 다시 그리지 않음 (애니메이션 반복 방지)
  async function refreshStatus() {
    try {
      const r = await fetch('/api/status');
      const { activeSheet } = await r.json();
      const key = activeSheet ? `${activeSheet.id}:${activeSheet.title}:${activeSheet.sheet_date}` : 'none';
      if (key === bannerKey) return;
      bannerKey = key;
      if (activeSheet) {
        sheetBanner.innerHTML = `
          <div class="sheet-card">
            <span class="stag ok">기록 중</span>
            <span class="sheet-title">${esc(activeSheet.title)}</span>
            <span class="sheet-date">${esc(activeSheet.sheet_date)}</span>
          </div>`;
      } else {
        sheetBanner.innerHTML = `
          <div class="sheet-card warn">
            <span>⚠️ 사용 중인 출석부가 없어 지금은 출석이 기록되지 않습니다</span>
            <a class="mini-btn" href="/admin">관리자에서 설정</a>
          </div>`;
      }
    } catch {
      /* 다음 주기에 재시도 */
    }
  }
  refreshStatus();
  setInterval(refreshStatus, 15000);

  // ── 카메라 ───────────────────────────────────────────
  async function startCamera() {
    offline.classList.remove('hidden');
    btnRetry.classList.add('hidden');
    offlineMsg.textContent = '카메라를 시작하는 중입니다…';
    camState.textContent = '카메라 준비 중';
    camState.className = 'stag';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      // 전면 카메라면 미리보기만 거울 모드로 (인식은 원본 영상 사용)
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      video.classList.toggle('mirror', settings.facingMode !== 'environment');
      offline.classList.add('hidden');
      camState.textContent = '스캔 대기 중';
      camState.className = 'stag ok';
      requestAnimationFrame(tick);
    } catch (e) {
      camState.textContent = '카메라 사용 불가';
      camState.className = 'stag err';
      offlineMsg.textContent = '카메라를 켤 수 없습니다. 브라우저의 카메라 권한을 허용해 주세요.';
      btnRetry.classList.remove('hidden');
    }
  }
  btnRetry.addEventListener('click', startCamera);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!stream || !stream.active)) startCamera();
  });

  // ── 스캔 루프 ────────────────────────────────────────
  // 작은 QR 도 잡히도록 두 전략을 번갈아 쓴다:
  //  A) 전체 화면을 640px 로 축소해 디코딩 (크고 가까운 코드)
  //  B) 중앙 프레임 영역을 원본 해상도로 잘라 디코딩 (작거나 먼 코드)
  let cropPass = false;
  async function tick(now) {
    if (!stream || !stream.active) return;
    requestAnimationFrame(tick);
    if (busy || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    if (now - lastDecodeAt < DECODE_INTERVAL) return;
    lastDecodeAt = now;
    cropPass = !cropPass;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    let sx = 0, sy = 0, sw = vw, sh = vh, target = 640;
    if (cropPass) {
      // 화면 중앙의 스캔 프레임 영역 (짧은 변의 60%) 을 원본 해상도로
      const side = Math.floor(Math.min(vw, vh) * 0.6);
      sx = Math.floor((vw - side) / 2);
      sy = Math.floor((vh - side) / 2);
      sw = sh = side;
      target = 800;
    }
    const scale = Math.min(target / sw, 1);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    let text = null;
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        if (codes.length) text = codes[0].rawValue;
      } catch {
        detector = null; // 실패 시 jsQR 로 전환
      }
    }
    if (text === null && typeof jsQR === 'function') {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (found) text = found.data;
    }
    if (text) onCode(text.trim());
  }

  async function onCode(code) {
    if (!code) return;
    const t = Date.now();
    if (code === lastCode && t - lastCodeAt < SAME_CODE_COOLDOWN) return;
    lastCode = code;
    lastCodeAt = t;

    busy = true;
    camState.textContent = '확인 중…';
    camState.className = 'stag';
    try {
      const r = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.status === 'ok') {
        showResult('ok', `${data.member.name}님`, '출석이 완료되었습니다.');
      } else if (data.status === 'already') {
        showResult('warn', `${data.member.name}님`, '이미 출석 처리되었습니다.');
      } else if (data.status === 'no_sheet') {
        showResult('err', '출석부 없음', '사용 중인 출석부가 없습니다. 관리자에게 문의해 주세요.');
        refreshStatus();
      } else if (data.status === 'unknown') {
        showResult('err', '알 수 없는 QR', '등록되지 않은 QR 코드입니다.');
      } else {
        showResult('err', '오류', data.error || '출석 처리 중 오류가 발생했습니다.');
      }
    } catch {
      showResult('err', '연결 오류', '네트워크 연결을 확인해 주세요.');
    }
  }

  function showResult(kind, name, msg) {
    const marks = { ok: '✓', warn: '!', err: '✕' };
    resultIcon.className = `result-icon ${kind}`;
    resultIcon.textContent = marks[kind];
    resultName.textContent = name;
    resultMsg.textContent = msg;
    modal.classList.add('show');
    clearTimeout(modalTimer);
    modalTimer = setTimeout(() => {
      modal.classList.remove('show');
      busy = false;
      camState.textContent = '스캔 대기 중';
      camState.className = 'stag ok';
    }, MODAL_MS);
  }

  startCamera();
})();
