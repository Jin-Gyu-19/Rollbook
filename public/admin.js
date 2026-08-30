/* Rollbook 관리자 — 출석부 CRUD · 출석 현황 · 명단 · QR 디자이너 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 공통: fetch + 토스트 ─────────────────────────────
  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  async function api(path, options = {}) {
    if (options.body) options.headers = { 'content-type': 'application/json', ...options.headers };
    const r = await fetch(path, options);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `요청 실패 (${r.status})`);
    return data;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ── 탭 ───────────────────────────────────────────────
  const tabs = $('tabs');
  function switchTab(name) {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const t of ['sheets', 'status', 'members', 'qr']) {
      const sec = $(`tab-${t}`);
      sec.classList.toggle('hidden', t !== name);
      if (t === name) {
        sec.classList.remove('screen-enter');
        void sec.offsetWidth;
        sec.classList.add('screen-enter');
      }
    }
    if (name === 'sheets') loadSheets();
    if (name === 'status') loadStatusTab();
    if (name === 'members') loadMembers();
    if (name === 'qr') loadQrTab();
  }
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // ── 편집 모달 ────────────────────────────────────────
  const editModal = $('editModal');
  let editSaveHandler = null;
  function openEdit(title, fieldsHtml, onSave) {
    $('editModalTitle').textContent = title;
    $('editModalFields').innerHTML = fieldsHtml;
    editSaveHandler = onSave;
    editModal.classList.remove('hidden');
  }
  function closeEdit() {
    editModal.classList.add('hidden');
    editSaveHandler = null;
  }
  $('btnEditCancel').addEventListener('click', closeEdit);
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
  $('btnEditSave').addEventListener('click', async () => {
    if (!editSaveHandler) return;
    try {
      await editSaveHandler();
      closeEdit();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // ═════════════════════════════════════════════════════
  // 출석부 탭
  // ═════════════════════════════════════════════════════
  let sheetsCache = [];

  $('sheetDate').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (로컬)

  $('btnCreateSheet').addEventListener('click', async () => {
    try {
      await api('/api/sheets', {
        method: 'POST',
        body: JSON.stringify({
          title: $('sheetTitle').value,
          sheet_date: $('sheetDate').value,
          activate: $('sheetActivate').checked,
        }),
      });
      $('sheetTitle').value = '';
      toast('출석부를 만들었습니다');
      loadSheets();
    } catch (e) {
      toast(e.message, true);
    }
  });

  async function loadSheets() {
    const { sheets, memberCount } = await api('/api/sheets').catch((e) => (toast(e.message, true), { sheets: [], memberCount: 0 }));
    sheetsCache = sheets;
    const holder = $('sheetList');
    if (!sheets.length) {
      holder.innerHTML = `<div class="empty"><span class="icon">🗂️</span>아직 출석부가 없습니다.<br>위에서 첫 출석부를 만들어 보세요.</div>`;
      return;
    }
    holder.innerHTML = `
      <table>
        <thead><tr><th>날짜</th><th>이름</th><th>상태</th><th>출석</th><th class="right">관리</th></tr></thead>
        <tbody>
          ${sheets.map((s) => `
            <tr>
              <td>${esc(s.sheet_date)}</td>
              <td><b>${esc(s.title)}</b></td>
              <td>${s.is_active ? '<span class="stag ok">기록 중</span>' : '<span class="stag">보관</span>'}</td>
              <td style="font-variant-numeric:tabular-nums;">${s.attended} / ${memberCount}명</td>
              <td class="right"><span class="row-actions" style="justify-content:flex-end;">
                <button class="small primary" data-act="scan" data-id="${s.id}">📷 출석 체크</button>
                <button class="small" data-act="view" data-id="${s.id}">현황</button>
                ${s.is_active ? `<button class="small ghost" data-act="deactivate" data-id="${s.id}">기록 중지</button>` : ''}
                <button class="small ghost" data-act="edit" data-id="${s.id}">수정</button>
                <button class="small danger" data-act="del" data-id="${s.id}">삭제</button>
              </span></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  $('sheetList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const sheet = sheetsCache.find((s) => s.id === id);
    try {
      if (b.dataset.act === 'scan') {
        // 이 출석부로 기록 시작 + 촬영 화면 열기
        await api(`/api/sheets/${id}/activate`, { method: 'POST' });
        location.href = '/';
      } else if (b.dataset.act === 'view') {
        switchTab('status');
        await loadStatusTab(id);
      } else if (b.dataset.act === 'deactivate') {
        await api(`/api/sheets/${id}/deactivate`, { method: 'POST' });
        toast('기록을 중지했습니다');
        loadSheets();
      } else if (b.dataset.act === 'edit') {
        openEdit('출석부 수정', `
          <label>출석부 이름 <input id="efTitle" value="${esc(sheet.title)}"></label>
          <label>날짜 <input id="efDate" type="date" value="${esc(sheet.sheet_date)}"></label>`,
          async () => {
            await api(`/api/sheets/${id}`, {
              method: 'PUT',
              body: JSON.stringify({ title: $('efTitle').value, sheet_date: $('efDate').value }),
            });
            toast('저장되었습니다');
            loadSheets();
          });
      } else if (b.dataset.act === 'del') {
        if (!confirm(`"${sheet.title}" 출석부와 그 출석 기록을 삭제할까요?`)) return;
        await api(`/api/sheets/${id}`, { method: 'DELETE' });
        toast('삭제되었습니다');
        loadSheets();
      }
    } catch (e2) {
      toast(e2.message, true);
    }
  });

  // ═════════════════════════════════════════════════════
  // 출석 현황 탭
  // ═════════════════════════════════════════════════════
  async function loadStatusTab(preferId) {
    const { sheets } = await api('/api/sheets').catch(() => ({ sheets: [] }));
    sheetsCache = sheets;
    const sel = $('statusSheetSel');
    if (!sheets.length) {
      sel.innerHTML = '<option>출석부 없음</option>';
      $('statusBody').innerHTML = `<div class="empty"><span class="icon">📭</span>아직 출석부가 없습니다.</div>`;
      return;
    }
    const chosen = preferId ?? (Number(sel.value) || (sheets.find((s) => s.is_active)?.id ?? sheets[0].id));
    sel.innerHTML = sheets
      .map((s) => `<option value="${s.id}" ${s.id === chosen ? 'selected' : ''}>${esc(s.sheet_date)} · ${esc(s.title)}${s.is_active ? ' (기록 중)' : ''}</option>`)
      .join('');
    await renderStatus(chosen);
  }
  $('statusSheetSel').addEventListener('change', () => renderStatus(Number($('statusSheetSel').value)));

  // 여러 PC 에서 동시에 쓸 때 실시간으로 보이도록 5초마다 자동 새로고침
  setInterval(() => {
    if (document.hidden) return;
    if ($('tab-status').classList.contains('hidden')) return;
    if (!$('editModal').classList.contains('hidden')) return;
    const id = Number($('statusSheetSel').value);
    if (id) renderStatus(id);
  }, 5000);

  async function renderStatus(sheetId) {
    const body = $('statusBody');
    let data;
    try {
      data = await api(`/api/sheets/${sheetId}`);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const { rows } = data;
    const total = rows.length;
    const attended = rows.filter((r) => r.checked_at).length;
    const pct = total ? Math.round((attended / total) * 100) : 0;

    if (!total) {
      body.innerHTML = `<div class="empty"><span class="icon">👥</span>등록된 인원이 없습니다.<br>명단 탭에서 인원을 먼저 추가해 주세요.</div>`;
      return;
    }

    body.innerHTML = `
      <div class="stat-row">
        <div class="stat-tile hero"><div class="v">${attended}명</div><div class="k">출석</div></div>
        <div class="stat-tile"><div class="v">${total - attended}명</div><div class="k">미출석</div></div>
        <div class="stat-tile"><div class="v">${pct}%</div><div class="k">출석률</div></div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:12.5px; color:var(--muted); margin-bottom:5px;">
        <span>출석 진행</span><span>${attended} / ${total}</span>
      </div>
      <div class="step-track" style="margin-bottom:18px;"><div class="step-fill" style="width:${pct}%"></div></div>
      <table>
        <thead><tr><th>이름</th><th>직함</th><th>부서</th><th>상태</th><th>출석 시각</th><th class="right">편집</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name)}</b></td>
              <td>${esc(r.title)}</td>
              <td>${esc(r.dept)}</td>
              <td>${r.checked_at ? '<span class="stag ok">출석</span>' : '<span class="stag err">미출석</span>'}</td>
              <td class="muted" style="font-variant-numeric:tabular-nums;">${fmtTime(r.checked_at)}</td>
              <td class="right">
                ${r.checked_at
                  ? `<button class="small ghost" data-mark="0" data-id="${r.member_id}">출석 취소</button>`
                  : `<button class="small" data-mark="1" data-id="${r.member_id}">출석 처리</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    body.onclick = async (e) => {
      const b = e.target.closest('button[data-mark]');
      if (!b) return;
      try {
        await api(`/api/sheets/${sheetId}/mark`, {
          method: 'POST',
          body: JSON.stringify({ member_id: Number(b.dataset.id), present: b.dataset.mark === '1' }),
        });
        toast(b.dataset.mark === '1' ? '출석 처리되었습니다' : '출석이 취소되었습니다');
        renderStatus(sheetId);
      } catch (e2) {
        toast(e2.message, true);
      }
    };
  }

  // ═════════════════════════════════════════════════════
  // 명단 탭
  // ═════════════════════════════════════════════════════
  let membersCache = [];

  $('btnCreateMember').addEventListener('click', async () => {
    try {
      await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          name: $('memberName').value,
          title: $('memberTitle').value,
          dept: $('memberDept').value,
        }),
      });
      $('memberName').value = '';
      $('memberTitle').value = '';
      toast('추가되었습니다 — QR 코드가 발급되었습니다');
      loadMembers();
    } catch (e) {
      toast(e.message, true);
    }
  });

  async function loadMembers() {
    const { members } = await api('/api/members').catch((e) => (toast(e.message, true), { members: [] }));
    membersCache = members;
    const holder = $('memberList');
    if (!members.length) {
      holder.innerHTML = `<div class="empty"><span class="icon">👥</span>아직 등록된 인원이 없습니다.<br>위에서 인원을 추가해 보세요.</div>`;
      return;
    }
    holder.innerHTML = `
      <table>
        <thead><tr><th>이름</th><th>직함</th><th>부서</th><th>QR 코드 값</th><th class="right">관리</th></tr></thead>
        <tbody>
          ${members.map((m) => `
            <tr>
              <td><b>${esc(m.name)}</b></td>
              <td>${esc(m.title)}</td>
              <td>${esc(m.dept)}</td>
              <td><span class="member-code">${esc(m.code)}</span></td>
              <td class="right"><span class="row-actions" style="justify-content:flex-end;">
                <button class="small" data-act="qr" data-id="${m.id}">QR 보기</button>
                <button class="small ghost" data-act="edit" data-id="${m.id}">수정</button>
                <button class="small danger" data-act="del" data-id="${m.id}">삭제</button>
              </span></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── 엑셀 일괄 등록 ───────────────────────────────────
  $('excelFile').addEventListener('change', async () => {
    const file = $('excelFile').files[0];
    if (!file) return;
    let rows = [];
    try {
      const buf = await file.arrayBuffer();
      if (/\.csv$/i.test(file.name)) {
        // 한글 CSV: UTF-8 로 읽고 깨지면 EUC-KR 재시도
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buf);
        rows = text.split(/\r?\n/).map((l) => l.split(',').map((s) => s.trim()));
      } else {
        const wb = XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      }
    } catch (e) {
      toast(`파일을 읽지 못했습니다: ${e.message}`, true);
      $('excelFile').value = '';
      return;
    }

    const members = extractMembers(rows);
    $('excelFile').value = '';
    if (!members.length) {
      toast('파일에서 등록할 인원을 찾지 못했습니다', true);
      return;
    }
    try {
      const r = await api('/api/members/bulk', { method: 'POST', body: JSON.stringify({ members }) });
      toast(`${r.added}명 등록 완료${r.skipped ? ` · ${r.skipped}건 건너뜀(중복/빈 줄)` : ''}`);
      loadMembers();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // 다양한 형태의 명단 엑셀에서 이름/부서를 알아서 찾아낸다:
  //  - 제목 줄 위 몇 줄이 있어도, 헤더가 이름/성명·부서/소속/팀 등이어도 인식
  //  - 헤더가 없고 첫 열이 연번(숫자)이면 한 칸 밀어서 인식
  function extractMembers(rows) {
    const grid = rows.map((r) => (Array.isArray(r) ? r : []).map((c) => String(c ?? '').trim()));
    const isNameHeader = (v) => ['이름', '성명', '성함', 'name'].includes(v.replace(/\s/g, '').toLowerCase());
    const isDeptHeader = (v) => {
      const w = v.replace(/\s/g, '');
      return ['부서', '소속', '팀', '본부', '부서명', '소속부서', 'department', 'dept', 'team']
        .some((h) => w.toLowerCase() === h) || w.includes('부서') || w.includes('소속');
    };
    const isTitleHeader = (v) => {
      const w = v.replace(/\s/g, '').toLowerCase();
      return ['직함', '직급', '직위', '직책', '호칭', 'title', 'position', 'rank', 'grade'].includes(w);
    };

    // 1) 앞 20행에서 헤더 행 탐색
    let nameCol = -1;
    let titleCol = -1;
    let deptCol = -1;
    let startRow = 0;
    let headerFound = false;
    for (let i = 0; i < Math.min(grid.length, 20) && !headerFound; i++) {
      for (let j = 0; j < grid[i].length; j++) {
        if (isNameHeader(grid[i][j])) {
          nameCol = j;
          for (let k = 0; k < grid[i].length; k++) {
            if (k === j) continue;
            if (deptCol < 0 && isDeptHeader(grid[i][k])) deptCol = k;
            if (titleCol < 0 && isTitleHeader(grid[i][k])) titleCol = k;
          }
          startRow = i + 1;
          headerFound = true;
          break;
        }
      }
    }

    // 2) 헤더가 없으면: 첫 열이 대부분 숫자(연번)면 한 칸 밀고,
    //    이름 다음 열이 직함(대리·과장 등)으로 보이면 부서는 그 다음 열로
    if (!headerFound) {
      const dataRows = grid.filter((r) => r.some(Boolean));
      const colRatio = (idx, test) => {
        const vals = dataRows.map((r) => r[idx] || '').filter(Boolean);
        return vals.filter(test).length / Math.max(vals.length, 1);
      };
      nameCol = colRatio(0, (v) => /^\d+$/.test(v)) > 0.6 ? 1 : 0;
      // 직함 판별: 한글 직함(공백 무시) + 영문 직함(대소문자·Senior/Junior 조합 허용)
      const KO_TITLE = /^(사원|주임|대리|과장|차장|부장|팀장|실장|본부장|지점장|이사|상무|전무|부사장|사장|회장|책임|선임|수석|위원|파트너|매니저|프로|컨설턴트|회계사|세무사|연구원|인턴|담당|주니어|시니어|어쏘시에이트|어소시에이트|시니어어쏘시에이트|시니어어소시에이트|디렉터)$/;
      const EN_TITLE = /^(senior|junior|sr\.?|jr\.?)?\s*(manager|associate|partner|director|staff|consultant|accountant|auditor|intern|analyst|assistant|ceo|cfo|coo)$/i;
      const isTitle = (v) => KO_TITLE.test(v.replace(/\s/g, '')) || EN_TITLE.test(v.replace(/\s+/g, ' ').trim());
      if (colRatio(nameCol + 1, isTitle) > 0.5) {
        titleCol = nameCol + 1;
        deptCol = nameCol + 2;
      } else {
        deptCol = nameCol + 1;
      }
    }

    const members = [];
    let lastDept = '';
    for (let i = startRow; i < grid.length; i++) {
      const r = grid[i];
      const name = (r[nameCol] || '').trim();
      const title = titleCol >= 0 ? (r[titleCol] || '').trim() : '';
      let dept = deptCol >= 0 ? (r[deptCol] || '').trim() : '';
      if (!name) continue;
      if (/^\d+$/.test(name)) continue;              // 숫자만 = 연번
      if (isNameHeader(name)) continue;              // 반복된 헤더 줄
      if (name.length > 20) continue;                // 제목·문장 줄
      if (headerFound && !dept && lastDept) dept = lastDept; // 병합 셀: 위 값 이어받기
      if (dept) lastDept = dept;
      members.push({ name, title, dept });
    }
    return members;
  }

  $('btnTemplate').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['이름', '직함', '부서'],
      ['홍길동', '과장', '감사1본부'],
      ['김철수', 'MANAGER', '디지털본부'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '명단');
    XLSX.writeFile(wb, 'rollbook-명단양식.xlsx');
  });

  $('memberList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const m = membersCache.find((x) => x.id === id);
    try {
      if (b.dataset.act === 'qr') {
        switchTab('qr');
        await loadQrTab(id);
      } else if (b.dataset.act === 'edit') {
        openEdit('인원 수정', `
          <label>이름 <input id="efName" value="${esc(m.name)}"></label>
          <label>직함 <input id="efTitle" value="${esc(m.title)}"></label>
          <label>부서 <input id="efDept" value="${esc(m.dept)}"></label>`,
          async () => {
            await api(`/api/members/${id}`, {
              method: 'PUT',
              body: JSON.stringify({ name: $('efName').value, title: $('efTitle').value, dept: $('efDept').value }),
            });
            toast('저장되었습니다');
            loadMembers();
          });
      } else if (b.dataset.act === 'del') {
        if (!confirm(`${m.name}님을 명단과 모든 출석 기록에서 삭제할까요?`)) return;
        await api(`/api/members/${id}`, { method: 'DELETE' });
        toast('삭제되었습니다');
        loadMembers();
      }
    } catch (e2) {
      toast(e2.message, true);
    }
  });

  // ═════════════════════════════════════════════════════
  // QR 코드 탭 — qr-code-styling + 로고 삽입
  // ═════════════════════════════════════════════════════
  // 회사 로고는 서버(D1)에 저장되어 상단바·스캐너·QR 모두에 적용된다
  let logoVer = 0;
  const logoUrl = () => `/api/logo?v=${logoVer}`;
  // 로고 스타일: center(가운데 로고) · pattern(점에 새기기) · none
  const storedLogoMode = localStorage.getItem('rollbook-qr-logo');
  const qrState = {
    dot: 'square',
    color: '#111827',
    logoMode: ['none', 'pattern', 'poster'].includes(storedLogoMode) ? storedLogoMode : 'center',
  };
  let qr = null;
  let patternCanvas = null; // '점에 새기기' 미리보기 캔버스 (다운로드에 재사용)
  let renderSeq = 0;

  function currentMember() {
    const id = Number($('qrMemberSel').value);
    return membersCache.find((m) => m.id === id) || null;
  }

  function renderQr() {
    const m = currentMember();
    const owner = $('qrOwner');
    const holder = $('qrHolder');
    if (!m) {
      holder.innerHTML = '<div class="empty" style="padding:40px 20px; width:240px;"><span class="icon">👤</span>대상을 선택해 주세요</div>';
      owner.innerHTML = '';
      $('btnDownloadQr').disabled = true;
      return;
    }
    $('btnDownloadQr').disabled = false;
    owner.innerHTML = `<b>${esc(m.name)}${m.title ? ` ${esc(m.title)}` : ''}${m.dept ? ` · ${esc(m.dept)}` : ''}</b><code>${esc(m.code)}</code>`;

    holder.innerHTML = '';
    qr = null;
    patternCanvas = null;
    if (qrState.logoMode === 'pattern' || qrState.logoMode === 'poster') {
      const seq = ++renderSeq;
      const build = qrState.logoMode === 'poster' ? buildPosterCanvas : buildPatternCanvas;
      build(m, 480)
        .then((canvas) => {
          if (seq !== renderSeq) return;
          canvas.style.maxWidth = '100%';
          holder.innerHTML = '';
          holder.appendChild(canvas);
          patternCanvas = canvas;
        })
        .catch((e) => {
          if (seq === renderSeq) toast(e.message, true);
        });
    } else {
      qr = new QRCodeStyling(buildQrOptions(m, 480));
      qr.append(holder);
    }
  }

  // ── '점에 새기기' 렌더러 ──────────────────────────────
  // 로고를 QR 중앙 위에 겹치지 않고, 어두운 모듈 중 로고가 지나가는
  // 자리만 로고 색으로 칠해 점 무늬 안에 로고가 새겨진 것처럼 보이게 한다.
  // 모듈 자체는 전부 어둡게 유지되므로 오류 보정을 소모하지 않는다.
  let logoImgCache = { ver: -1, promise: null };
  function loadLogoImage() {
    if (logoImgCache.ver !== logoVer || !logoImgCache.promise) {
      logoImgCache = {
        ver: logoVer,
        promise: new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('로고 이미지를 불러오지 못했습니다'));
          img.src = logoUrl();
        }),
      };
    }
    return logoImgCache.promise;
  }

  // 로고를 모듈 격자에 맞춰 3×3 슈퍼샘플링 — (row, col) → 색상 | null
  function makeLogoSampler(img, count) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const S = 3;
    const off = document.createElement('canvas');
    off.width = count * S;
    off.height = count * S;
    const octx = off.getContext('2d', { willReadFrequently: true });
    // 가로는 QR 좌우 끝까지 꽉 채우고, 세로만 모서리 파인더 패턴을 피하도록 제한
    const k = Math.min((count * S) / w, ((count - 16) * S) / h);
    const dw = w * k;
    const dh = h * k;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(img, (count * S - dw) / 2, (count * S - dh) / 2, dw, dh);
    const px = octx.getImageData(0, 0, count * S, count * S).data;
    return (r, c) => {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const i = ((r * S + dy) * count * S + (c * S + dx)) * 4;
          const a = px[i + 3] / 255;
          sr += px[i] * a;
          sg += px[i + 1] * a;
          sb += px[i + 2] * a;
          sa += a;
        }
      }
      if (sa < S * S * 0.35) return null; // 모듈의 1/3 이상 덮일 때만 로고 색 적용
      let R = sr / sa, G = sg / sa, B = sb / sa;
      const lum = 0.299 * R + 0.587 * G + 0.114 * B;
      if (lum > 210) return null; // 로고의 흰 배경 부분은 일반 점으로
      if (lum > 150) { // 스캐너가 어두운 모듈로 읽도록 밝은 색은 눌러 준다
        const d = 150 / lum;
        R *= d; G *= d; B *= d;
      }
      return [R | 0, G | 0, B | 0];
    };
  }

  function drawPatternDot(ctx, x, y, s) {
    ctx.beginPath();
    if (qrState.dot === 'dots') {
      // 이웃과 맞닿는 반지름 — 더 작으면 jsQR 가 어두운 면적 부족으로 못 읽는다
      ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
    } else if (qrState.dot === 'rounded' && ctx.roundRect) {
      ctx.roundRect(x + s * 0.04, y + s * 0.04, s * 0.92, s * 0.92, s * 0.32);
    } else if (qrState.dot === 'classy-rounded' && ctx.roundRect) {
      // 0.3 이하일 때만 jsQR 가 안정적으로 읽는다 (0.42↑는 디코드 실패 확인)
      ctx.roundRect(x, y, s + 0.2, s + 0.2, [s * 0.3, 0, s * 0.3, 0]);
    } else {
      ctx.rect(x, y, s + 0.35, s + 0.35); // 미세한 이음새 방지 여유
    }
    ctx.fill();
  }

  function drawPatternFinder(ctx, x, y, s, forceRounded) {
    const rounded = (forceRounded || qrState.dot !== 'square') && !!ctx.roundRect;
    ctx.fillStyle = qrState.color;
    ctx.strokeStyle = qrState.color;
    ctx.lineWidth = s;
    ctx.beginPath();
    if (rounded) ctx.roundRect(x + s / 2, y + s / 2, s * 6, s * 6, s * 2);
    else ctx.rect(x + s / 2, y + s / 2, s * 6, s * 6);
    ctx.stroke();
    ctx.beginPath();
    if (rounded && qrState.dot === 'dots') ctx.arc(x + s * 3.5, y + s * 3.5, s * 1.5, 0, Math.PI * 2);
    else if (rounded) ctx.roundRect(x + s * 2, y + s * 2, s * 3, s * 3, s);
    else ctx.rect(x + s * 2, y + s * 2, s * 3, s * 3);
    ctx.fill();
  }

  // qr-code-styling 내부의 QR 행렬만 빌려 온다 (H 보정, 미리보기와 동일 데이터).
  // 자동 버전(25×25)은 칸이 적어 로고 글자가 뭉개지므로 버전 8(49×49)로
  // 올려 해상도를 확보한다 — 데이터가 넘치면 자동 버전으로 되돌아간다.
  function makeQrGrid(code, typeNumber = 8) {
    let helper;
    try {
      helper = new QRCodeStyling({ data: `ROLLBOOK:${code}`, qrOptions: { typeNumber, errorCorrectionLevel: 'H' } });
    } catch {
      helper = new QRCodeStyling({ data: `ROLLBOOK:${code}`, qrOptions: { errorCorrectionLevel: 'H' } });
    }
    if (!helper._qr) throw new Error('QR 코드를 생성하지 못했습니다');
    return helper._qr;
  }

  async function buildPatternCanvas(m, size) {
    const grid = makeQrGrid(m.code);
    const count = grid.getModuleCount();

    let sampler = null;
    try {
      sampler = makeLogoSampler(await loadLogoImage(), count);
    } catch {
      // 로고를 못 불러오면 로고 없이 일반 점으로 그린다
    }

    const margin = Math.round(size / 60);
    const mod = (size - margin * 2) / count;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    const isFinder = (r, c) =>
      (r < 7 && c < 7) || (r < 7 && c >= count - 7) || (r >= count - 7 && c < 7);

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (isFinder(r, c)) continue;
        const logoColor = sampler ? sampler(r, c) : null;
        if (grid.isDark(r, c)) {
          ctx.fillStyle = logoColor ? `rgb(${logoColor[0]},${logoColor[1]},${logoColor[2]})` : qrState.color;
          drawPatternDot(ctx, margin + c * mod, margin + r * mod, mod);
        } else if (logoColor) {
          // 흰 칸에도 아주 연한 로고 색을 깔아 글자를 면으로 채운다.
          // 흰색 75% 혼합이면 밝은 모듈로 안전하게 남는다 (jsQR 검증 완료)
          ctx.fillStyle = `rgb(${(logoColor[0] * 0.25 + 191.25) | 0},${(logoColor[1] * 0.25 + 191.25) | 0},${(logoColor[2] * 0.25 + 191.25) | 0})`;
          ctx.fillRect(margin + c * mod, margin + r * mod, mod + 0.35, mod + 0.35);
        }
      }
    }
    drawPatternFinder(ctx, margin, margin, mod);
    drawPatternFinder(ctx, margin + (count - 7) * mod, margin, mod);
    drawPatternFinder(ctx, margin, margin + (count - 7) * mod, mod);
    return canvas;
  }

  // ── '포스터' 렌더러 (버거킹 스타일) ───────────────────
  // 로고 원본 이미지를 매끈하게 그대로 얹고, 로고 위의 밝은 모듈 자리에
  // 흰 점을 뚫는다. 로고 밖 어두운 모듈은 성긴 점으로 그린다.
  // 성긴 점은 jsQR 가 못 읽으므로 이 스타일은 ZXing 내장 스캐너 전제.
  async function buildPosterCanvas(m, size) {
    // 로고가 원본 이미지 그대로라 격자 해상도가 필요 없으므로 버전 5(37칸)로
    // 낮춰 모듈을 키운다 — 소형 인쇄에서 인식 거리가 v8 대비 약 1.36배
    const grid = makeQrGrid(m.code, 5);
    const count = grid.getModuleCount();

    let img = null;
    let sampler = null;
    try {
      img = await loadLogoImage();
      sampler = makeLogoSampler(img, count);
    } catch {
      // 로고를 못 불러오면 점만 그린다
    }

    const margin = Math.round(size / 60);
    const mod = (size - margin * 2) / count;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    // 로고 원본을 샘플러와 같은 배치(가로 꽉 채움, 세로는 파인더 회피)로 그린다
    if (img && sampler) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const k = Math.min(count / w, (count - 16) / h); // 모듈 단위 배율
      const dw = w * k * mod;
      const dh = h * k * mod;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, margin + (count * mod - dw) / 2, margin + (count * mod - dh) / 2, dw, dh);
    }

    const isFinder = (r, c) =>
      (r < 7 && c < 7) || (r < 7 && c >= count - 7) || (r >= count - 7 && c < 7);

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (isFinder(r, c)) continue;
        const x = margin + c * mod;
        const y = margin + r * mod;
        const ink = sampler ? sampler(r, c) : null;
        ctx.beginPath();
        if (grid.isDark(r, c)) {
          // 로고 잉크 위는 잉크 색 점으로 중심을 보강(글자 가장자리에 걸친 모듈 대비),
          // 로고 밖은 성긴 점
          ctx.fillStyle = ink ? `rgb(${ink[0]},${ink[1]},${ink[2]})` : qrState.color;
          ctx.arc(x + mod / 2, y + mod / 2, mod * 0.35, 0, Math.PI * 2);
        } else if (ink) {
          // 로고 잉크 위 밝은 모듈: 흰 구멍
          ctx.fillStyle = '#FFFFFF';
          ctx.arc(x + mod / 2, y + mod / 2, mod * 0.4, 0, Math.PI * 2);
        } else {
          continue;
        }
        ctx.fill();
      }
    }
    drawPatternFinder(ctx, margin, margin, mod, true);
    drawPatternFinder(ctx, margin + (count - 7) * mod, margin, mod, true);
    drawPatternFinder(ctx, margin, margin + (count - 7) * mod, mod, true);
    return canvas;
  }

  // 현재 디자인 설정으로 QR 옵션 구성 (미리보기·일괄 다운로드 공용)
  function buildQrOptions(m, size) {
    return {
      width: size,
      height: size,
      type: 'canvas',
      data: `ROLLBOOK:${m.code}`,
      margin: Math.round(size / 60),
      qrOptions: { errorCorrectionLevel: 'H' },
      dotsOptions: { type: qrState.dot, color: qrState.color },
      cornersSquareOptions: {
        type: qrState.dot === 'square' ? 'square' : 'extra-rounded',
        color: qrState.color,
      },
      cornersDotOptions: { type: qrState.dot === 'square' ? 'square' : 'dot', color: qrState.color },
      backgroundOptions: { color: '#FFFFFF' },
      image: qrState.logoMode === 'center' ? logoUrl() : undefined,
      imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35, hideBackgroundDots: true },
    };
  }

  async function loadQrTab(preferId) {
    if (!membersCache.length) {
      const { members } = await api('/api/members').catch(() => ({ members: [] }));
      membersCache = members;
    }
    const sel = $('qrMemberSel');
    if (!membersCache.length) {
      sel.innerHTML = '<option value="">등록된 인원 없음 — 명단 탭에서 추가</option>';
    } else {
      const chosen = preferId ?? (Number(sel.value) || membersCache[0].id);
      sel.innerHTML = membersCache
        .map((m) => `<option value="${m.id}" ${m.id === chosen ? 'selected' : ''}>${esc(m.name)}${m.title ? ` ${esc(m.title)}` : ''}${m.dept ? ` (${esc(m.dept)})` : ''}</option>`)
        .join('');
    }
    updateLogoUi();
    renderQr();
  }
  $('qrMemberSel').addEventListener('change', renderQr);

  function bindSeg(segId, key) {
    $(segId).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      $(segId).querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      qrState[key] = b.dataset.v;
      renderQr();
    });
  }
  bindSeg('qrDotSeg', 'dot');
  bindSeg('qrColorSeg', 'color');

  $('qrLogoSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    qrState.logoMode = b.dataset.v;
    try {
      if (qrState.logoMode === 'center') localStorage.removeItem('rollbook-qr-logo');
      else localStorage.setItem('rollbook-qr-logo', qrState.logoMode);
    } catch {}
    updateLogoUi();
    renderQr();
  });

  function updateLogoUi() {
    $('qrLogoSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === qrState.logoMode));
    const showThumb = qrState.logoMode !== 'none';
    $('logoThumb').classList.toggle('hidden', !showThumb);
    if (showThumb) $('logoThumb').src = logoUrl();
  }

  // 로고 업로드 → 서버 저장 → 모든 화면에 즉시 반영
  $('logoFile').addEventListener('change', () => {
    const file = $('logoFile').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast('로고 파일은 1MB 이하로 올려 주세요', true);
      $('logoFile').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api('/api/logo', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) });
        logoVer = Date.now();
        if (qrState.logoMode === 'none') {
          qrState.logoMode = 'center';
          try { localStorage.removeItem('rollbook-qr-logo'); } catch {}
        }
        document.querySelectorAll('.brand-logo').forEach((el) => { el.src = logoUrl(); });
        toast('로고가 저장되었습니다 — 모든 화면에 적용됩니다');
        updateLogoUi();
        renderQr();
      } catch (e) {
        toast(e.message, true);
      }
    };
    reader.readAsDataURL(file);
  });

  $('btnDownloadQr').addEventListener('click', () => {
    const m = currentMember();
    if (!m) return;
    if (qrState.logoMode === 'pattern' || qrState.logoMode === 'poster') {
      if (!patternCanvas) return;
      const a = document.createElement('a');
      a.href = patternCanvas.toDataURL('image/png');
      a.download = `rollbook-qr-${m.name}.png`;
      a.click();
    } else if (qr) {
      qr.download({ name: `rollbook-qr-${m.name}`, extension: 'png' });
    }
  });

  // 전체 QR 을 ZIP 으로 일괄 다운로드 (현재 디자인·로고 적용, 인쇄용 720px)
  $('btnDownloadAll').addEventListener('click', async () => {
    if (!membersCache.length) {
      const { members } = await api('/api/members').catch(() => ({ members: [] }));
      membersCache = members;
    }
    if (!membersCache.length) {
      toast('등록된 인원이 없습니다', true);
      return;
    }
    const btn = $('btnDownloadAll');
    btn.disabled = true;
    try {
      const zip = new JSZip();
      for (let i = 0; i < membersCache.length; i++) {
        const m = membersCache[i];
        btn.textContent = `생성 중… ${i + 1}/${membersCache.length}`;
        let blob;
        if (qrState.logoMode === 'pattern' || qrState.logoMode === 'poster') {
          const build = qrState.logoMode === 'poster' ? buildPosterCanvas : buildPatternCanvas;
          const canvas = await build(m, 720);
          blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        } else {
          const q = new QRCodeStyling(buildQrOptions(m, 720));
          blob = await q.getRawData('png');
        }
        const safeName = `${m.name}${m.dept ? `_${m.dept}` : ''}`.replace(/[\\/:*?"<>|]/g, '_');
        zip.file(`${safeName}_${m.code}.png`, blob);
      }
      btn.textContent = '압축 중…';
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'rollbook-qr.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(`QR 코드 ${membersCache.length}개를 내려받았습니다`);
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = '전체 내려받기 (ZIP)';
  });

  // ── 초기 로드 ────────────────────────────────────────
  loadSheets();
})();
