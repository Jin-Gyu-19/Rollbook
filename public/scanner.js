/* Rollbook 스캐너 — 상시 카메라 + QR 인식 → 출석 체크 */
(() => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('frame');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const offline = document.getElementById('cameraOffline');
  const offlineMsg = document.getElementById('cameraOfflineMsg');
  const btnRetry = document.getElementById('btnRetryCamera');
  const camState = document.getElementById('camState');
  const scanPill = document.getElementById('scanPill');
  const sheetBanner = document.getElementById('sheetBanner');

  // 하단 상태 알약: kind = '' | 'ok' | 'err'
  function setCam(text, kind) {
    camState.textContent = text;
    scanPill.className = 'scan-pill' + (kind ? ` ${kind}` : '');
  }
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

  // ── 사운드 (Web Audio 합성 — 파일 불필요) ────────────
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // 자동재생 정책 대비: 화면을 한 번이라도 만지면 오디오 활성화
  document.addEventListener('pointerdown', ensureAudio);

  function tone(ctx, freq, start, dur, peak, type) {
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function playSound(kind) {
    const ctx = ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    if (kind === 'ok') {
      // 띵–동 (하강 차임)
      tone(ctx, 880, 0, 0.5, 0.3);
      tone(ctx, 1760, 0, 0.25, 0.08);      // 배음으로 맑게
      tone(ctx, 659.25, 0.22, 0.7, 0.3);
      tone(ctx, 1318.5, 0.22, 0.3, 0.08);
    } else if (kind === 'warn') {
      // 이미 출석: 짧은 삑삑
      tone(ctx, 523.25, 0, 0.14, 0.2);
      tone(ctx, 523.25, 0.2, 0.14, 0.2);
    } else {
      // 오류: 낮은 부저
      tone(ctx, 196, 0, 0.4, 0.18, 'square');
    }
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
          <div class="sheet-card glass">
            <span class="stag ok">기록 중</span>
            <span class="sheet-title">${esc(activeSheet.title)}</span>
            <span class="sheet-date">${esc(activeSheet.sheet_date)}</span>
          </div>`;
      } else {
        sheetBanner.innerHTML = `
          <div class="sheet-card glass warn">
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

  // ── 우측 실시간 출석부 패널 ──────────────────────────
  const attPanel = document.getElementById('attPanel');
  const panelList = document.getElementById('panelList');
  const panelCount = document.getElementById('panelCount');
  let latestCheckedAt = ''; // 마지막으로 본 최신 기록
  let glowCheckedAt = null; // 지금 네온 글로우 중인 기록 (10초 or 다음 출석까지)
  let glowTimer = null;

  function fmtClock(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async function loadRecent() {
    try {
      const r = await fetch('/api/recent');
      const d = await r.json();
      if (!d.sheet) {
        panelCount.textContent = '';
        panelList.innerHTML = '<div class="att-empty">사용 중인 출석부가 없습니다</div>';
        return;
      }
      panelCount.textContent = `${d.attended} / ${d.total}명`;
      if (!d.entries.length) {
        panelList.innerHTML = '<div class="att-empty">아직 출석한 사람이 없습니다<br>첫 번째 주인공이 되어 보세요!</div>';
        latestCheckedAt = '';
        return;
      }
      // 새 출석이 생기면 글로우가 그 사람에게 넘어가고, 없으면 10초 후 꺼진다
      const top = d.entries[0].checked_at;
      if (latestCheckedAt && top > latestCheckedAt) {
        glowCheckedAt = top;
        clearTimeout(glowTimer);
        glowTimer = setTimeout(() => {
          glowCheckedAt = null;
          panelList.querySelectorAll('.att-row.new').forEach((el) => el.classList.remove('new'));
        }, 10000);
      }
      panelList.innerHTML = d.entries.map((e, i) => `
        <div class="att-row${e.checked_at === glowCheckedAt ? ' new' : ''}">
          <span class="att-no">${d.attended - i}</span>
          <span class="att-check">✓</span>
          <span class="att-name">${esc(e.name)}${e.title ? `<small>${esc(e.title)}</small>` : ''}</span>
          <span class="att-dept">${esc(e.dept)}</span>
          <span class="att-time">${fmtClock(e.checked_at)}</span>
        </div>`).join('');
      latestCheckedAt = top;
    } catch {
      /* 다음 주기에 재시도 */
    }
  }
  loadRecent();
  setInterval(loadRecent, 5000);

  // ── 카메라 ───────────────────────────────────────────
  async function startCamera() {
    offline.classList.remove('hidden');
    btnRetry.classList.add('hidden');
    offlineMsg.textContent = '카메라를 시작하는 중입니다…';
    setCam('카메라 준비 중…', '');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      // 전면 카메라면 미리보기만 거울 모드로 (인식은 원본 영상 사용)
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      video.classList.toggle('mirror', settings.facingMode !== 'environment');
      offline.classList.add('hidden');
      setCam('명찰을 테두리 안에 맞춰 주세요', 'ok');
      requestAnimationFrame(tick);
    } catch (e) {
      setCam('카메라를 사용할 수 없습니다 — 권한을 확인해 주세요', 'err');
      offlineMsg.textContent = '카메라를 켤 수 없습니다. 브라우저의 카메라 권한을 허용해 주세요.';
      btnRetry.classList.remove('hidden');
    }
  }
  btnRetry.addEventListener('click', startCamera);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!stream || !stream.active)) startCamera();
  });

  // ── 스캔 루프 ────────────────────────────────────────
  // 세 전략을 순환한다:
  //  0) 전체 화면을 640px 로 축소 (크고 가까운 코드)
  //  1) 명찰 프레임 영역(세로형 3:4)을 고화질로 — 명찰 안 QR 이 어디 있든 인식
  //  2) 중앙 40% 정사각형을 원본 화질로 (아주 작은 코드 — 디지털 돋보기)
  let passIdx = 0;
  async function tick(now) {
    if (!stream || !stream.active) return;
    requestAnimationFrame(tick);
    if (busy || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    if (now - lastDecodeAt < DECODE_INTERVAL) return;
    lastDecodeAt = now;
    passIdx = (passIdx + 1) % 3;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    let sx = 0, sy = 0, sw = vw, sh = vh, target = 640;
    if (passIdx > 0) {
      const minSide = Math.min(vw, vh);
      let cw, ch;
      if (passIdx === 1) {
        ch = Math.floor(minSide * 0.8);       // 명찰 프레임 높이
        cw = Math.floor(ch * 0.75);           // 3:4 비율
      } else {
        cw = ch = Math.floor(minSide * 0.4);  // 중앙 정밀 스캔
      }
      sx = Math.floor((vw - cw) / 2);
      sy = Math.floor((vh - ch) / 2);
      sw = cw;
      sh = ch;
      target = 1000;
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
    setCam('확인 중…', '');
    try {
      const r = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.status === 'ok') {
        showResult('ok', `${data.member.name}${data.member.title ? ` ${data.member.title}` : ''}님`, '출석이 완료되었습니다.');
        loadRecent(); // 우측 출석부에 바로 반영
      } else if (data.status === 'already') {
        showResult('warn', `${data.member.name}${data.member.title ? ` ${data.member.title}` : ''}님`, '이미 출석 처리되었습니다.');
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
    playSound(kind);
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
      setCam('명찰을 테두리 안에 맞춰 주세요', 'ok');
    }, MODAL_MS);
  }

  startCamera();
})();
