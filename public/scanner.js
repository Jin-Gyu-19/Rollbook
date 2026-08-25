/* Rollbook 스캐너 — 상시 카메라 + QR 인식 → 출석 체크 */
(() => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('frame');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const offline = document.getElementById('cameraOffline');
  const offlineMsg = document.getElementById('cameraOfflineMsg');
  const btnRetry = document.getElementById('btnRetryCamera');
  const camState = document.getElementById('camState');
  const sheetState = document.getElementById('sheetState');
  const sheetHint = document.getElementById('sheetHint');
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

  // ── 활성 출석부 표시 ─────────────────────────────────
  async function refreshStatus() {
    try {
      const r = await fetch('/api/status');
      const { activeSheet } = await r.json();
      if (activeSheet) {
        sheetState.textContent = `${activeSheet.title} · ${activeSheet.sheet_date}`;
        sheetState.classList.remove('hidden');
        sheetHint.textContent = '';
      } else {
        sheetState.classList.add('hidden');
        sheetHint.textContent = '사용 중인 출석부가 없습니다. 관리자 페이지에서 출석부를 만들어 "사용"으로 지정해 주세요.';
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
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
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
  async function tick(now) {
    if (!stream || !stream.active) return;
    requestAnimationFrame(tick);
    if (busy || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    if (now - lastDecodeAt < DECODE_INTERVAL) return;
    lastDecodeAt = now;

    let text = null;
    if (detector) {
      try {
        const codes = await detector.detect(video);
        if (codes.length) text = codes[0].rawValue;
      } catch {
        detector = null; // 실패 시 jsQR 로 전환
      }
    }
    if (text === null && typeof jsQR === 'function') {
      const scale = 480 / Math.max(video.videoWidth, 1);
      canvas.width = Math.round(video.videoWidth * Math.min(scale, 1));
      canvas.height = Math.round(video.videoHeight * Math.min(scale, 1));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
