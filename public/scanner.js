/* Rollbook 스캐너 — 상시 카메라 + QR 인식 → 출석 체크 */
(() => {
  const video = document.getElementById('video');
  const videoClear = document.getElementById('videoClear');
  const frameBox = document.querySelector('.scan-frame .box');
  const canvas = document.getElementById('frame');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const offline = document.getElementById('cameraOffline');
  const offlineMsg = document.getElementById('cameraOfflineMsg');
  const btnRetry = document.getElementById('btnRetryCamera');
  const camState = document.getElementById('camState');
  const scanPill = document.getElementById('scanPill');

  // 하단 상태 알약: kind = '' | 'ok' | 'err'
  function setCam(text, kind) {
    camState.textContent = text;
    scanPill.className = 'scan-pill' + (kind ? ` ${kind}` : '');
  }

  // 카메라가 실제로 주는 해상도 진단 표시 — 소형 QR 인식 거리는 해상도에 비례한다
  const camRes = document.getElementById('camRes');
  function showCamRes(settings) {
    const w = settings.width, h = settings.height;
    if (!w || !h) {
      camRes.textContent = '';
      return;
    }
    const low = Math.min(w, h) < 1080; // 1080p 미만이면 소형(25mm) QR 인식이 어렵다
    camRes.textContent = `${w}×${h}${low ? ' · 해상도 낮음' : ''}`;
    camRes.classList.toggle('low', low);
  }
  const modal = document.getElementById('resultModal');
  const resultRing = document.getElementById('resultRing');
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

  // ZXing-WASM: jsQR 보다 훨씬 관대한 2차 디코더 (포스터 스타일 QR 도 읽는다)
  let zxingReady = false;
  if (window.ZXingWASM?.readBarcodes) {
    try {
      ZXingWASM.prepareZXingModule({
        overrides: { locateFile: () => '/vendor/zxing_reader.wasm' },
        fireImmediately: true, // 스캔 첫 프레임 전에 WASM 미리 로드
      });
      zxingReady = true;
    } catch {
      /* 로드 실패 시 jsQR 만 사용 */
    }
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

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 오프라인 출석 ────────────────────────────────────
  // 행사장 인터넷이 끊겨도 스캔이 멈추면 안 된다. 그래서
  //   1) 연결돼 있을 때 명단·출석부를 이 PC 에 받아 두고,
  //   2) 끊긴 동안은 이 PC 안에 기록을 쌓고,
  //   3) 연결이 돌아오면 쌓아 둔 것을 한꺼번에 올린다.
  // 쌓아 둔 기록은 서버가 받았다고 확인해 준 것만 지운다 — 그래야 한 건도 안 없어진다.
  const OFF_PACK = 'rb_off_pack';      // 명단 꾸러미
  const OFF_QUEUE = 'rb_off_queue';    // 아직 못 올린 기록
  const PACK_REFRESH_MS = 5 * 60 * 1000;
  const BATCH_SIZE = 100;

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };

  let pack = store.get(OFF_PACK, null);       // { at, sheet, members:[], attended:[[id,at]] }
  let queue = store.get(OFF_QUEUE, []);       // [{ code, at, sheet_id, member_id, name, title, dept }]
  if (!Array.isArray(queue)) queue = [];
  let byCode = new Map();
  let byId = new Map();
  let localAttended = new Map();              // member_id → checked_at (꾸러미 + 대기열)
  let packAt = 0;
  let syncing = false;
  // 스캔 PC 의 시계가 틀어져 있어도 기록 시각이 맞도록, 연결돼 있을 때
  // 서버 시각과의 차이를 재 두었다가 오프라인 기록에 반영한다.
  let clockSkew = Number(store.get('rb_off_skew', 0)) || 0;
  const nowIso = () => new Date(Date.now() + clockSkew).toISOString();
  let offlineMode = false;                    // 마지막 서버 요청이 실패했나
  let offlineSince = 0;
  // 인터넷이 죽었는데 와이파이는 잡혀 있는 곳에서는 요청이 '멈춰 서서' 시간을 다 잡아먹는다.
  // 한 번 끊긴 것을 알면 잠시 동안은 서버를 건너뛰고 바로 이 PC 에 기록한다.
  const OFFLINE_HOLD_MS = 15000;
  function markOffline() { offlineMode = true; offlineSince = Date.now(); }
  function markOnline() { offlineMode = false; offlineSince = 0; }
  const skipServer = () => !navigator.onLine || (offlineMode && Date.now() - offlineSince < OFFLINE_HOLD_MS);

  function indexPack() {
    byCode = new Map();
    byId = new Map();
    localAttended = new Map();
    if (!pack) return;
    for (const m of pack.members || []) { byCode.set(m.code, m); byId.set(m.id, m); }
    for (const [id, at] of pack.attended || []) localAttended.set(id, at);
    for (const q of queue) {
      if (!q.member_id) continue;
      const had = localAttended.get(q.member_id);
      if (!had || q.at < had) localAttended.set(q.member_id, q.at);
    }
  }
  indexPack();

  // 이 사람은 이미 출석했다고 이 PC 에 남긴다 (온라인·오프라인 모두).
  // 꾸러미에 같이 적어 두어야 새로고침해도 기억한다.
  function markAttended(memberId, at) {
    if (!memberId || !at) return;
    const had = localAttended.get(memberId);
    if (had && had <= at) return;
    localAttended.set(memberId, at);
    if (!pack) return;
    if (!Array.isArray(pack.attended)) pack.attended = [];
    const i = pack.attended.findIndex((x) => x[0] === memberId);
    if (i < 0) pack.attended.push([memberId, at]);
    else pack.attended[i][1] = at;
    store.set(OFF_PACK, pack);
  }

  function saveQueue() {
    if (!store.set(OFF_QUEUE, queue)) {
      // 저장소가 막힌 PC — 조용히 넘어가면 기록이 사라지므로 화면에 알린다
      setOffChip('저장 공간을 쓸 수 없습니다 — 관리자에게 알려 주세요', true);
    }
    paintOffChip();
  }

  // 화면 위쪽 상태 알림 (연결 상태 · 아직 못 올린 건수)
  const offChip = document.getElementById('offChip');
  const offChipText = document.getElementById('offChipText');
  let chipOverride = '';
  function setOffChip(msg, sticky) {
    chipOverride = msg || '';
    paintOffChip();
    if (msg && !sticky) setTimeout(() => { if (chipOverride === msg) { chipOverride = ''; paintOffChip(); } }, 4000);
  }
  function paintOffChip() {
    if (!offChip) return;
    const pending = queue.length;
    let cls = 'scan-chip off-chip';
    let text;
    if (chipOverride) {
      text = chipOverride;
      cls += ' warn';
    } else if (offlineMode || !navigator.onLine) {
      text = pending ? `오프라인 · 이 PC 에 ${pending}건 저장됨` : '오프라인 · 명단으로 출석 받는 중';
      cls += ' bad';
    } else if (pending) {
      text = `올리는 중 · ${pending}건 남음`;
      cls += ' warn';
    } else if (!pack) {
      text = '오프라인 준비 안 됨';
      cls += ' warn';
    } else {
      text = `오프라인 준비됨 · ${(pack.members || []).length}명`;
      cls += ' good';
    }
    offChipText.textContent = text;
    offChip.className = cls;
    offChip.hidden = false;
  }

  // 명단 꾸러미 받아 두기 (연결돼 있을 때만)
  async function refreshPack(force) {
    if (!force && Date.now() - packAt < PACK_REFRESH_MS) return;
    try {
      const r = await fetch('/api/offline/pack', { cache: 'no-store' });
      if (r.status === 401) return toLogin();
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d.members)) return;
      pack = d;
      packAt = Date.now();
      const serverAt = Date.parse(d.at);
      if (!Number.isNaN(serverAt)) {
        const skew = serverAt - Date.now();
        // 하루 넘게 벌어진 값은 무언가 잘못된 것이니 쓰지 않는다
        clockSkew = Math.abs(skew) < 24 * 60 * 60 * 1000 ? skew : 0;
        store.set('rb_off_skew', clockSkew);
      }
      store.set(OFF_PACK, pack);
      indexPack();
      markOnline();
      paintOffChip();
    } catch {
      markOffline();
      paintOffChip();
    }
  }

  // 오프라인에서 QR 한 장 처리 — 받아 둔 명단으로 판단하고 이 PC 에 쌓는다
  function offlineCheckin(rawCode) {
    const code = rawCode.startsWith('ROLLBOOK:') ? rawCode.slice('ROLLBOOK:'.length) : rawCode;
    if (!pack || !byCode.size) return { status: 'not_ready' };
    if (!pack.sheet) return { status: 'no_sheet' };
    const m = byCode.get(code);
    if (!m) return { status: 'unknown' };
    const had = localAttended.get(m.id);
    if (had) return { status: 'already', member: m, checked_at: had, offline: true };
    const at = nowIso();
    queue.push({ code, at, sheet_id: pack.sheet.id, member_id: m.id, name: m.name, title: m.title, dept: m.dept });
    markAttended(m.id, at);
    saveQueue();
    return { status: 'ok', member: m, checked_at: at, offline: true };
  }

  // 쌓아 둔 기록 올리기 — 서버가 확인해 준 것만 대기열에서 뺀다
  async function syncQueue(manual) {
    if (syncing || !queue.length) return;
    if (!navigator.onLine && !manual) return;
    syncing = true;
    paintOffChip();
    let sent = 0, dropped = 0, kept = 0;
    try {
      while (queue.length) {
        const chunk = queue.slice(0, BATCH_SIZE);
        const r = await fetch('/api/checkin/batch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk.map((q) => ({ code: q.code, at: q.at, sheet_id: q.sheet_id })) }),
        });
        if (r.status === 401) { toLogin(); break; }
        if (!r.ok) { kept = queue.length; break; }          // 서버가 거절 — 그대로 두고 다음에 다시
        const d = await r.json().catch(() => null);
        if (!d || !Array.isArray(d.results)) { kept = queue.length; break; }
        // 서버가 결과를 준 자리만 대기열에서 뺀다
        const keepIdx = new Set();
        d.results.forEach((res, i) => {
          if (!res) { keepIdx.add(i); return; }
          if (res.status === 'no_sheet') { keepIdx.add(i); return; }  // 출석부가 아직 없다 — 나중에 다시
          if (res.status === 'unknown' || res.status === 'invalid') dropped += 1;
          else sent += 1;
        });
        const keepItems = chunk.filter((_, i) => keepIdx.has(i));
        queue = keepItems.concat(queue.slice(chunk.length));
        saveQueue();
        if (keepItems.length === chunk.length) { kept = queue.length; break; }  // 더 못 올린다
      }
      markOnline();
      if (sent || dropped) {
        const bits = [];
        if (sent) bits.push(`${sent}건 올림`);
        if (dropped) bits.push(`${dropped}건은 등록되지 않은 QR 이라 건너뜀`);
        if (kept) bits.push(`${kept}건은 다음에 다시 시도`);
        setOffChip(bits.join(' · '));
      }
      await refreshPack(true);
      loadRecent();
    } catch {
      markOffline();
    } finally {
      syncing = false;
      paintOffChip();
    }
  }

  window.addEventListener('online', () => { markOnline(); paintOffChip(); refreshPack(true); syncQueue(); });
  window.addEventListener('offline', () => { markOffline(); paintOffChip(); });
  offChip?.addEventListener('click', () => { refreshPack(true); syncQueue(true); });

  // 점검용 — 카메라 없이 콘솔에서 QR 값을 넣어 볼 수 있다.
  //   rbScan('RB-XXXX-XXXX')  ← 스캔한 것과 똑같이 동작한다
  //   rbOffline.state()       ← 지금 상태 (대기 건수·명단 수·연결)
  window.rbScan = (code) => onCode(String(code || '').trim());
  window.rbOffline = {
    state: () => ({ pending: queue.length, members: (pack?.members || []).length, sheet: pack?.sheet?.id ?? null, offline: offlineMode }),
    queue: () => queue.slice(),
    sync: () => syncQueue(true),
    refresh: () => refreshPack(true),
  };

  // ── 우측 실시간 출석부 패널 ──────────────────────────
  const attPanel = document.getElementById('attPanel');
  const panelList = document.getElementById('panelList');
  const panelCount = document.getElementById('panelCount');
  const panelSheetTitle = document.getElementById('panelSheetTitle');
  const panelSheetSub = document.getElementById('panelSheetSub');
  let latestCheckedAt = null; // 마지막으로 본 최신 기록 (null = 아직 한 번도 안 읽음)
  let glowCheckedAt = null; // 지금 네온 글로우 중인 기록 (10초 or 다음 출석까지)
  let glowTimer = null;

  // 스캐너 PC 의 시간대와 상관없이 늘 한국시간(KST)으로 보여 준다.
  const kstClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  function fmtClock(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : kstClock.format(d);
  }

  // 로그인이 풀리면 로그인 화면으로 (한 번만)
  let authRedirected = false;
  function toLogin() {
    if (authRedirected) return;
    authRedirected = true;
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }

  async function loadRecent() {
    try {
      const r = await fetch('/api/recent');
      if (r.status === 401) return toLogin();
      const d = await r.json();
      if (!d.sheet) {
        panelSheetTitle.textContent = '출석부';
        panelSheetSub.className = 'scan-panel-sub off';
        panelSheetSub.innerHTML = '<span class="rec-dot"></span>사용 중인 출석부 없음';
        panelCount.textContent = '';
        panelList.innerHTML = '<div class="att-empty">관리자에서 출석부를 만들고<br>"출석 체크"를 눌러 주세요<br><br><a class="mini-btn" href="/admin">관리자로 이동</a></div>';
        return;
      }
      panelSheetTitle.textContent = d.sheet.title;
      panelSheetSub.className = 'scan-panel-sub';
      panelSheetSub.innerHTML = `<span class="rec-dot"></span>기록 중 · ${esc(d.sheet.sheet_date)}`;
      panelCount.textContent = `${d.attended} / ${d.total}명`;
      if (!d.entries.length) {
        panelList.innerHTML = '<div class="att-empty">아직 출석한 사람이 없습니다<br>첫 번째 주인공이 되어 보세요!</div>';
        latestCheckedAt = '';
        return;
      }
      // 새 출석이 생기면 글로우가 그 사람에게 넘어가고, 없으면 10초 후 꺼진다.
      // 첫 화면을 띄운 순간의 기록에는 켜지 않지만(null), 빈 출석부에서 처음
      // 출석한 사람('' 과 비교)에게는 켜 준다.
      const top = d.entries[0].checked_at;
      if (latestCheckedAt !== null && top > latestCheckedAt) {
        lastActivity = Date.now(); // 다른 PC 에서 스캔이 들어오고 있다 — 한동안 자주 묻는다
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
      markOnline();
      paintOffChip();
    } catch {
      // 서버에 못 닿았다 — 이 PC 가 아는 것으로 그린다
      markOffline();
      paintOffChip();
      renderPanel();
    }
  }

  // 오프라인일 때의 우측 패널 — 받아 둔 명단 + 이 PC 에 쌓인 기록으로 그린다
  function renderPanel() {
    if (!pack) {
      panelSheetTitle.textContent = '출석부';
      panelSheetSub.className = 'scan-panel-sub off';
      panelSheetSub.innerHTML = '<span class="rec-dot"></span>오프라인 · 받아 둔 명단 없음';
      panelCount.textContent = '';
      panelList.innerHTML = '<div class="att-empty">인터넷이 될 때 이 화면을<br>한 번 열어 두어야 합니다</div>';
      return;
    }
    panelSheetTitle.textContent = pack.sheet ? pack.sheet.title : '출석부';
    panelSheetSub.className = 'scan-panel-sub off';
    panelSheetSub.innerHTML = `<span class="rec-dot"></span>오프라인 · ${esc(pack.sheet ? pack.sheet.sheet_date : '출석부 없음')}`;
    panelCount.textContent = `${localAttended.size} / ${(pack.members || []).length}명`;
    const rows = [...localAttended.entries()]
      .map(([id, at]) => ({ m: byId.get(id), at }))
      .filter((x) => x.m)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (!rows.length) {
      panelList.innerHTML = '<div class="att-empty">아직 출석한 사람이 없습니다</div>';
      return;
    }
    const n = rows.length;
    panelList.innerHTML = rows.map((e, i) => `
        <div class="att-row">
          <span class="att-no">${n - i}</span>
          <span class="att-check">✓</span>
          <span class="att-name">${esc(e.m.name)}${e.m.title ? `<small>${esc(e.m.title)}</small>` : ''}</span>
          <span class="att-dept">${esc(e.m.dept)}</span>
          <span class="att-time">${fmtClock(e.at)}</span>
        </div>`).join('');
  }
  // ── 폴링 — 움직임이 있을 때만 자주 묻고, 조용하면 뜸하게 ──
  // 클라우드플레어 무료 플랜은 하루 10만 요청이라, 5초마다 무조건 묻던 방식(PC 한 대에
  // 시간당 720번)을 줄인다. 이 PC 가 스캔했거나 다른 PC 의 새 기록을 본 뒤 1분 동안은
  // 4초마다, 그 뒤로는 30초마다. 화면이 가려져 있으면(다른 탭·최소화) 아예 묻지 않는다.
  // 이 PC 의 스캔은 응답 즉시 목록을 갱신하므로 폴링은 '다른 PC 의 스캔' 을 보기 위한 것.
  const POLL_FAST = 4000;
  const POLL_SLOW = 30000;
  const ACTIVE_FOR = 60000;
  let lastActivity = Date.now();
  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    const busy = Date.now() - lastActivity < ACTIVE_FOR;
    pollTimer = setTimeout(pollTick, busy ? POLL_FAST : POLL_SLOW);
  }
  async function pollTick() {
    if (!document.hidden) await loadRecent();
    schedulePoll();
  }
  window.rbPollState = () => (Date.now() - lastActivity < ACTIVE_FOR ? 'fast' : 'slow'); // 점검용
  loadRecent();
  schedulePoll();

  // 오프라인 채비 — 명단을 받아 두고, 지난번에 못 올린 것이 있으면 올린다
  paintOffChip();
  refreshPack(true).then(() => syncQueue());
  setInterval(() => { if (!document.hidden && navigator.onLine) { refreshPack(); syncQueue(); } }, PACK_REFRESH_MS);
  // 끊긴 동안에는 더 자주 두드려 본다 — 인터넷이 돌아오면 바로 올리기 위해
  setInterval(() => {
    if (document.hidden || !navigator.onLine) return;
    if (offlineMode || queue.length) { refreshPack(true); syncQueue(); }
  }, 20000);

  // 인터넷이 끊겨도 이 화면이 열리도록 화면 파일을 이 PC 에 담아 둔다
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 안 되면 온라인으로만 동작 */ });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadRecent();      // 다시 보이면 바로 한 번
    schedulePoll();
  });

  // 로그아웃 — 이 PC 를 다른 QR 로 다시 로그인시킬 때
  document.getElementById('btnLogout')?.addEventListener('click', async () => {
    if (!confirm('이 컴퓨터에서 로그아웃할까요?\n다시 쓰려면 로그인 QR 을 비춰야 합니다.')) return;
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch { /* 무시 */ }
    location.href = '/login';
  });

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
      // 같은 영상을 '또렷한 창' 에도 물린다 (테두리 안쪽만 보이도록 오려 쓴다)
      if (videoClear) {
        videoClear.srcObject = stream;
        videoClear.play().catch(() => {});
      }
      // 전면 카메라면 미리보기만 거울 모드로 (인식은 원본 영상 사용)
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      const mirror = settings.facingMode !== 'environment';
      video.classList.toggle('mirror', mirror);
      videoClear?.classList.toggle('mirror', mirror);
      syncClearWindow();
      showCamRes(settings);
      offline.classList.add('hidden');
      setCam('명찰을 테두리 안에 맞춰 주세요', 'ok');
      requestAnimationFrame(tick);
    } catch (e) {
      setCam('카메라를 사용할 수 없습니다 — 권한을 확인해 주세요', 'err');
      offlineMsg.textContent = '카메라를 켤 수 없습니다. 브라우저의 카메라 권한을 허용해 주세요.';
      btnRetry.classList.remove('hidden');
    }
  }
  // 명찰 테두리 위치에 맞춰 '또렷한 창' 을 오려 낸다.
  // 테두리 크기가 화면에 따라 달라지므로 실제 위치를 재서 맞춘다.
  function syncClearWindow() {
    if (!videoClear || !frameBox) return;
    const r = frameBox.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const top = Math.max(0, r.top);
    const left = Math.max(0, r.left);
    const right = Math.max(0, window.innerWidth - r.right);
    const bottom = Math.max(0, window.innerHeight - r.bottom);
    videoClear.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round 18px)`;
  }
  window.addEventListener('resize', syncClearWindow);
  window.addEventListener('orientationchange', syncClearWindow);
  if (window.ResizeObserver && frameBox) new ResizeObserver(syncClearWindow).observe(frameBox);
  syncClearWindow();

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

    // 소형(20~25mm) 인쇄 QR 은 모듈당 3.5px 이상 필요해서 처리 해상도가 곧 인식 거리다
    let sx = 0, sy = 0, sw = vw, sh = vh, target = 960;
    if (passIdx > 0) {
      const minSide = Math.min(vw, vh);
      let cw, ch;
      if (passIdx === 1) {
        ch = Math.floor(minSide * 0.95);      // 명찰 프레임 높이 (화면 거의 전체)
        cw = Math.floor(ch * 0.75);           // 3:4 비율
      } else {
        cw = ch = Math.floor(minSide * 0.45); // 중앙 정밀 스캔
      }
      sx = Math.floor((vw - cw) / 2);
      sy = Math.floor((vh - ch) / 2);
      sw = cw;
      sh = ch;
      target = 1440;
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
    if (text === null && (zxingReady || typeof jsQR === 'function')) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (zxingReady) {
        try {
          const found = await ZXingWASM.readBarcodes(img, { formats: ['QRCode'], tryHarder: true, tryInvert: true });
          if (found.length && found[0].isValid) text = found[0].text;
        } catch {
          zxingReady = false; // WASM 실패 시 이후 jsQR 만 사용
        }
      }
      if (text === null && typeof jsQR === 'function') {
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (found) text = found.data;
      }
    }
    if (text) onCode(text.trim());
  }

  // 서버가 죽었는데 끊긴 줄도 모르는 상황(사내망 차단 등)에서 스캔이 멈추지 않게,
  // 이만큼 기다려도 답이 없으면 오프라인으로 본다.
  const CHECKIN_TIMEOUT_MS = 5000;

  async function onCode(code) {
    if (!code) return;
    const t = Date.now();
    if (code === lastCode && t - lastCodeAt < SAME_CODE_COOLDOWN) return;
    lastCode = code;
    lastCodeAt = t;

    busy = true;
    setCam('확인 중…', '');
    // 이미 끊긴 것을 알면 서버를 기다리지 않고 바로 이 PC 에 기록한다
    if (skipServer()) return showOffline(offlineCheckin(code));
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), CHECKIN_TIMEOUT_MS);
      let r;
      try {
        r = await fetch('/api/checkin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: ac.signal,
        });
      } finally { clearTimeout(timer); }
      if (r.status === 401) return toLogin();
      markOnline();
      paintOffChip();
      const data = await r.json().catch(() => ({}));
      // 온라인으로 찍힌 사람도 이 PC 의 '이미 출석' 목록에 넣어 둔다.
      // 안 그러면 곧바로 인터넷이 끊겼을 때 같은 사람을 또 받아 버린다.
      if (data.status === 'ok' || data.status === 'already') {
        const bare = code.startsWith('ROLLBOOK:') ? code.slice('ROLLBOOK:'.length) : code;
        const m = byCode.get(bare);
        if (m && data.checked_at) markAttended(m.id, data.checked_at);
      }
      const who = data.member
        ? `${data.member.name}${data.member.title ? ` ${data.member.title}` : ''}님`
        : '';
      if (data.status === 'ok') {
        showResult('ok', {
          name: who,
          msg: `${data.member.dept ? `${data.member.dept} · ` : ''}${fmtClock(data.checked_at)} 출석`,
          mark: '✓',
        });
        lastActivity = Date.now();
        loadRecent(); // 우측 출석부에 바로 반영
      } else if (data.status === 'already') {
        showResult('warn', {
          name: who,
          msg: `이미 출석 처리되어 있습니다 · ${fmtClock(data.checked_at)}`,
          mark: '!',
        });
      } else if (data.status === 'no_sheet') {
        showResult('err', { name: '출석부 없음', msg: '사용 중인 출석부가 없습니다. 관리자에게 문의해 주세요.', mark: '✕' });
        loadRecent();
      } else if (data.status === 'unknown') {
        showResult('err', { name: '알 수 없는 QR', msg: '등록되지 않은 QR 코드입니다.', mark: '✕' });
      } else {
        showResult('err', { name: '오류', msg: data.error || '출석 처리 중 오류가 발생했습니다.', mark: '✕' });
      }
    } catch {
      // 서버에 닿지 못했다 — 받아 둔 명단으로 이 PC 에 기록한다
      markOffline();
      showOffline(offlineCheckin(code));
    }
  }

  // 오프라인으로 처리한 결과를 화면에 보여 준다
  function showOffline(res) {
    const m = res.member;
    const who = m ? `${m.name}${m.title ? ` ${m.title}` : ''}님` : '';
    if (res.status === 'ok') {
      showResult('ok', {
        name: who,
        msg: `${m.dept ? `${m.dept} · ` : ''}${fmtClock(res.checked_at)} 출석 · 오프라인 기록`,
        mark: '✓',
      });
      lastActivity = Date.now();
      renderPanel();
    } else if (res.status === 'already') {
      showResult('warn', { name: who, msg: `이미 출석 처리되어 있습니다 · ${fmtClock(res.checked_at)}`, mark: '!' });
    } else if (res.status === 'unknown') {
      showResult('err', { name: '알 수 없는 QR', msg: '받아 둔 명단에 없는 QR 입니다.', mark: '✕' });
    } else if (res.status === 'no_sheet') {
      showResult('err', { name: '출석부 없음', msg: '받아 둘 때 기록 중인 출석부가 없었습니다.', mark: '✕' });
    } else {
      showResult('err', {
        name: '오프라인 준비 안 됨',
        msg: '인터넷이 될 때 이 화면을 한 번 열어 명단을 받아 두어야 합니다.',
        mark: '✕',
      });
    }
    paintOffChip();
  }

  function showResult(kind, { name = '', msg = '', mark = '✓' } = {}) {
    playSound(kind);
    resultName.textContent = name;
    resultMsg.textContent = msg;
    resultRing.className = `result-ring ${kind}`;
    resultRing.textContent = mark;
    // 링 애니메이션을 매번 다시 재생
    resultRing.style.animation = 'none';
    void resultRing.offsetWidth;
    resultRing.style.animation = '';
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
