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
    if (r.status === 401 && data.auth) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
      throw new Error('로그인이 필요합니다.');
    }
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
    for (const t of ['sheets', 'status', 'members', 'qr', 'security']) {
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
    if (name === 'security') loadSecurityTab();
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
    renderMembers();
  }

  // 검색어로 걸러진 명단 (일괄 내려받기도 이 결과를 씁니다)
  function filteredMembers() {
    const q = ($('memberSearch')?.value ?? '').trim().toLowerCase();
    if (!q) return membersCache;
    return membersCache.filter((m) =>
      [m.name, m.title, m.dept, m.code].some((v) => String(v ?? '').toLowerCase().includes(q)));
  }

  function renderMembers() {
    const holder = $('memberList');
    const members = filteredMembers();
    const q = ($('memberSearch')?.value ?? '').trim();
    $('memberCount').textContent = membersCache.length
      ? (q ? `${members.length} / ${membersCache.length}명` : `${membersCache.length}명`)
      : '';
    if (!membersCache.length) {
      holder.innerHTML = `<div class="empty"><span class="icon">👥</span>아직 등록된 인원이 없습니다.<br>위에서 인원을 추가해 보세요.</div>`;
      return;
    }
    if (!members.length) {
      holder.innerHTML = `<div class="empty"><span class="icon">🔍</span>"${esc(q)}" 와 맞는 사람이 없습니다.</div>`;
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

  $('memberSearch').addEventListener('input', renderMembers);

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
  // ── 명단 QR 일괄 내려받기 (PDF) ─────────────────────
  // 한 페이지에 10명 = 2열 × 5줄. A4 210×297mm, 여백 12mm.
  const SHEET = { cols: 2, rows: 5, marginX: 12, marginY: 14, qrMm: 34, gapY: 2 };

  // 지금 고른 디자인으로 QR 이미지(dataURL) 만들기
  async function memberQrDataUrl(m, px = 560) {
    if (qrState.logoMode === 'pattern' || qrState.logoMode === 'poster') {
      const build = qrState.logoMode === 'poster' ? buildPosterCanvas : buildPatternCanvas;
      return (await build(m, px)).toDataURL('image/png');
    }
    const holder = document.createElement('div');
    new QRCodeStyling(buildQrOptions(m, px)).append(holder);
    for (let i = 0; i < 60 && !holder.querySelector('canvas'); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 250)); // 로고가 얹힐 때까지
    return holder.querySelector('canvas').toDataURL('image/png');
  }

  // 한글은 PDF 기본 글꼴로 안 나오므로 캔버스에 그려 이미지로 넣는다.
  // 캔버스 폭을 고정해 두면 PDF 에서 항상 같은 크기로 보이고,
  // 이름이 길어 폭을 넘치면 그 줄만 글자를 줄여 칸 안에 맞춘다.
  function textImage(lines, widthPx = 560) {
    const measure = document.createElement('canvas').getContext('2d');
    const fontOf = (l, size) =>
      `${l.bold ? '700 ' : ''}${size}px 'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif`;
    const fitted = lines.map((l) => {
      let size = l.size;
      measure.font = fontOf(l, size);
      const w = measure.measureText(l.text).width;
      if (w > widthPx) size = Math.max(10, Math.floor(size * (widthPx / w)));
      return { ...l, size };
    });

    const c = document.createElement('canvas');
    let h = 6;
    for (const l of fitted) h += Math.round(l.size * 1.35);
    c.width = widthPx;
    c.height = h + 6;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.textBaseline = 'top';
    let y = 6;
    for (const l of fitted) {
      ctx.font = fontOf(l, l.size);
      ctx.fillStyle = l.color || '#111827';
      ctx.fillText(l.text, 0, y);
      y += Math.round(l.size * 1.35);
    }
    return { dataUrl: c.toDataURL('image/png'), ratio: c.height / c.width };
  }

  // 한 사람 칸 그리기 (자르는 선 + QR + 이름·직함·부서)
  function drawCell(doc, m, qrDataUrl, x, y, cellW, cellH) {
    doc.setDrawColor(215);
    doc.setLineWidth(0.2);
    doc.rect(x, y, cellW, cellH);
    const pad = 4;
    const qr = SHEET.qrMm;
    doc.addImage(qrDataUrl, 'PNG', x + pad, y + (cellH - qr) / 2, qr, qr, undefined, 'FAST');
    const tx = x + pad + qr + 4;
    const tw = cellW - (pad + qr + 4) - pad;
    const lines = [{ text: `${m.name}${m.title ? ` ${m.title}` : ''}`, size: 62, bold: true }];
    if (m.dept) lines.push({ text: m.dept, size: 46, color: '#6B7280' });
    lines.push({ text: m.code, size: 38, color: '#9CA3AF' });
    const img = textImage(lines);
    const th = tw * img.ratio;
    doc.addImage(img.dataUrl, 'PNG', tx, y + (cellH - th) / 2, tw, th, undefined, 'FAST');
  }

  // 한 파일: 한 페이지에 10명
  async function buildOnePdf(list, btn) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = 210;
    const pageH = 297;
    const cellW = (pageW - SHEET.marginX * 2) / SHEET.cols;
    const cellH = (pageH - SHEET.marginY * 2) / SHEET.rows;
    const perPage = SHEET.cols * SHEET.rows;

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      btn.textContent = `만드는 중… ${i + 1}/${list.length}`;
      const slot = i % perPage;
      if (i > 0 && slot === 0) doc.addPage();
      const col = slot % SHEET.cols;
      const row = Math.floor(slot / SHEET.cols);
      const x = SHEET.marginX + col * cellW;
      const y = SHEET.marginY + row * cellH;
      drawCell(doc, m, await memberQrDataUrl(m), x, y, cellW, cellH);
    }
    btn.textContent = '저장 중…';
    doc.save(`Rollbook_QR_${list.length}명.pdf`);
  }

  // 사람별 파일: 각자 한 장짜리 PDF 를 만들어 ZIP 으로
  async function buildEachPdfZip(list, btn) {
    const { jsPDF } = window.jspdf;
    const zip = new JSZip();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      btn.textContent = `만드는 중… ${i + 1}/${list.length}`;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const qr = 60;
      doc.addImage(await memberQrDataUrl(m, 720), 'PNG', (210 - qr) / 2, 45, qr, qr, undefined, 'FAST');
      const lines = [{ text: `${m.name}${m.title ? ` ${m.title}` : ''}`, size: 96, bold: true }];
      if (m.dept) lines.push({ text: m.dept, size: 62, color: '#6B7280' });
      lines.push({ text: m.code, size: 48, color: '#9CA3AF' });
      const img = textImage(lines, 900);
      const tw = 120;
      doc.addImage(img.dataUrl, 'PNG', (210 - tw) / 2, 45 + qr + 8, tw, tw * img.ratio, undefined, 'FAST');
      const safe = `${m.name}${m.dept ? `_${m.dept}` : ''}_${m.code}`.replace(/[\\/:*?"<>|]/g, '_');
      zip.file(`${safe}.pdf`, doc.output('blob'));
    }
    btn.textContent = '압축 중…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Rollbook_QR_${list.length}명.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ── 엑셀(xlsx) 로 내려받기 — QR 이미지를 셀에 넣는다 ──
  // SheetJS 무료판은 이미지를 못 넣어서, xlsx(=zip) 구조를 직접 만든다.
  const XE = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PX2EMU = 9525;

  async function buildXlsx(list, btn) {
    const COLS = [
      { title: '순번', width: 6 },
      { title: 'QR 코드', width: 13 },
      { title: '이름', width: 14 },
      { title: '직함', width: 16 },
      { title: '부서', width: 20 },
      { title: 'QR 값', width: 18 },
    ];
    const ROW_PT = 62;      // 줄 높이(포인트) — QR 이 들어갈 만큼
    const QR_PX = 76;       // 셀 안 QR 크기(픽셀)
    const images = [];      // {name, blob}

    // 시트 본문
    let rows = '';
    // 1행: 제목
    rows += '<row r="1" ht="20" customHeight="1">' +
      COLS.map((c, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr" s="1"><is><t>${XE(c.title)}</t></is></c>`).join('') +
      '</row>';

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      btn.textContent = `만드는 중… ${i + 1}/${list.length}`;
      const dataUrl = await memberQrDataUrl(m, 320);
      images.push({ name: `qr${i + 1}.png`, dataUrl });
      const r = i + 2;
      const cell = (col, val) => `<c r="${col}${r}" t="inlineStr"><is><t>${XE(val)}</t></is></c>`;
      rows += `<row r="${r}" ht="${ROW_PT}" customHeight="1">` +
        `<c r="A${r}"><v>${i + 1}</v></c>` +
        cell('C', m.name) + cell('D', m.title) + cell('E', m.dept) + cell('F', m.code) +
        '</row>';
    }

    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:F${list.length + 1}"/>` +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="16.5"/>' +
      '<cols>' + COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('') + '</cols>' +
      `<sheetData>${rows}</sheetData>` +
      '<drawing r:id="rId1"/></worksheet>';

    // 그림 배치 — B열(index 1) 각 줄에 QR 하나
    const anchors = images.map((_, i) => {
      const row = i + 1; // 0-based, 제목 줄 다음
      return '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>${6 * PX2EMU}</xdr:colOff>` +
        `<xdr:row>${row}</xdr:row><xdr:rowOff>${4 * PX2EMU}</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${QR_PX * PX2EMU}" cy="${QR_PX * PX2EMU}"/>` +
        '<xdr:pic><xdr:nvPicPr>' +
        `<xdr:cNvPr id="${i + 2}" name="QR ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${QR_PX * PX2EMU}" cy="${QR_PX * PX2EMU}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
        '<xdr:clientData/></xdr:oneCellAnchor>';
    }).join('');

    const zip = new JSZip();
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
      '</Types>');
    zip.file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>');
    zip.file('xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>' +
      '<sheets><sheet name="명단" sheetId="1" state="visible" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>');
    zip.file('xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font>' +
      '<font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '</styleSheet>');
    zip.file('xl/worksheets/sheet1.xml', sheet);
    zip.file('xl/worksheets/_rels/sheet1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
      '</Relationships>');
    zip.file('xl/drawings/drawing1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      anchors + '</xdr:wsDr>');
    zip.file('xl/drawings/_rels/drawing1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      images.map((im, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${im.name}"/>`).join('') +
      '</Relationships>');
    for (const im of images) {
      zip.file(`xl/media/${im.name}`, im.dataUrl.split(',')[1], { base64: true });
    }

    btn.textContent = '저장 중…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Rollbook_명단_${list.length}명.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  $('btnBulkQr').addEventListener('click', async () => {
    if (!membersCache.length) {
      const { members } = await api('/api/members').catch(() => ({ members: [] }));
      membersCache = members;
    }
    const list = $('bulkScope').value === 'filtered' ? filteredMembers() : membersCache;
    if (!list.length) {
      toast($('bulkScope').value === 'filtered' ? '검색 결과가 없습니다' : '등록된 인원이 없습니다', true);
      return;
    }
    const btn = $('btnBulkQr');
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const fmt = $('bulkFormat').value;
      if (fmt === 'each') await buildEachPdfZip(list, btn);
      else if (fmt === 'xlsx') await buildXlsx(list, btn);
      else await buildOnePdf(list, btn);
      toast(`${list.length}명의 QR 을 내려받았습니다`);
    } catch (e) {
      toast(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = label;
  });

  // ── 보안 탭 ──────────────────────────────────────────
  async function loadSecurityTab() {
    loadAdmins();
    loadPasswordState();
    loadBadgeLogin();
  }

  // 명찰 QR 로도 로그인할 수 있게 할지
  async function loadBadgeLogin() {
    try {
      const { enabled } = await api('/api/auth/badge-login');
      $('badgeLogin').checked = enabled;
      setBadgeHint(enabled);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function setBadgeHint(enabled) {
    $('badgeLoginHint').innerHTML = enabled
      ? '켜져 있습니다 — 관리자는 명찰 하나로 출석 체크와 관리자 로그인을 모두 할 수 있습니다. 명찰이 복사되면 관리자 권한도 함께 넘어가니, 명찰을 잃어버렸을 때는 명단에서 그 사람의 QR 을 새로 발급하세요.'
      : '꺼져 있습니다 — 명찰 QR 은 출석 체크에만 쓰이고, 로그인은 로그인 QR 이나 비밀번호로만 됩니다.';
  }

  $('badgeLogin').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      await api('/api/auth/badge-login', { method: 'POST', body: JSON.stringify({ enabled }) });
      setBadgeHint(enabled);
      toast(enabled ? '명찰 QR 로도 로그인할 수 있습니다' : '명찰 QR 로는 로그인할 수 없게 했습니다');
    } catch (err) {
      e.target.checked = !enabled;
      toast(err.message, true);
    }
  });

  // 관리자 비밀번호 등록 여부에 따라 화면을 맞춘다
  async function loadPasswordState() {
    try {
      const { registered } = await api('/api/auth/admin-password');
      $('pwCurrentWrap').classList.toggle('hidden', !registered);
      $('btnRemovePw').classList.toggle('hidden', !registered);
      $('btnSavePw').textContent = registered ? '변경' : '등록';
      $('pwStateMsg').textContent = registered
        ? '비밀번호가 등록되어 있습니다. 로그인 화면에서 QR 과 비밀번호 중 하나를 골라 로그인할 수 있습니다.'
        : 'QR 없이도 로그인할 수 있게 비밀번호를 등록해 둘 수 있습니다. 등록하면 로그인 화면에 "비밀번호로 로그인" 이 나타납니다.';
    } catch (e) {
      toast(e.message, true);
    }
  }

  $('btnSavePw').addEventListener('click', async () => {
    const next = $('pwNext').value;
    if (next !== $('pwNext2').value) return toast('새 비밀번호 두 개가 서로 다릅니다.', true);
    if (next.length < 6) return toast('비밀번호는 6자 이상으로 정해 주세요.', true);
    try {
      await api('/api/auth/admin-password', {
        method: 'POST',
        body: JSON.stringify({ current: $('pwCurrent').value, next }),
      });
      $('pwCurrent').value = $('pwNext').value = $('pwNext2').value = '';
      toast('관리자 비밀번호를 저장했습니다');
      loadPasswordState();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnRemovePw').addEventListener('click', async () => {
    if (!confirm('비밀번호를 없애면 앞으로 QR 로만 로그인할 수 있습니다. 계속할까요?')) return;
    try {
      await api('/api/auth/admin-password', { method: 'DELETE' });
      $('pwCurrent').value = $('pwNext').value = $('pwNext2').value = '';
      toast('비밀번호를 없앴습니다 — 이제 QR 로만 로그인합니다');
      loadPasswordState();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // 로그인 QR 캔버스 (사이트에서 쓰는 디자인 그대로 — 로고 + 오류보정 H)
  async function renderLoginQrCanvas(payload, px = 720) {
    const qr = new QRCodeStyling({
      width: px, height: px, type: 'canvas',
      data: payload,
      margin: Math.round(px / 60),
      qrOptions: { errorCorrectionLevel: 'H' },
      dotsOptions: { type: 'square', color: '#111827' },
      backgroundOptions: { color: '#FFFFFF' },
      image: logoUrl(),
      imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35, hideBackgroundDots: true },
    });
    const holder = document.createElement('div');
    qr.append(holder);
    for (let i = 0; i < 60 && !holder.querySelector('canvas'); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 350)); // 로고가 얹힐 때까지
    return holder.querySelector('canvas');
  }

  // 로그인 QR PNG 내려받기 (관리자·스캐너 공용)
  async function downloadLoginQr(payload, filename) {
    const canvas = await renderLoginQrCanvas(payload, 720);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename.replace(/[\\/:*?"<>|]/g, '_');
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  // 인쇄용 PDF — 같은 QR 을 30·40·50mm 세 크기로 한 장에
  const PRINT_SIZES_MM = [30, 40, 50];
  async function downloadLoginQrPdf(payload, who, filename) {
    const canvas = await renderLoginQrCanvas(payload, 900);
    const dataUrl = canvas.toDataURL('image/png');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    // 한글은 PDF 기본 글꼴로 안 나오므로 캔버스에 그려서 이미지로 넣는다
    const drawText = (lines, xMm, yMm, widthMm) => {
      const W = 1600;
      const pad = 6;
      const c = document.createElement('canvas');
      const ctx0 = c.getContext('2d');
      const font = (l) => `${l.bold ? '700 ' : ''}${l.size}px 'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif`;
      let h = pad;
      for (const l of lines) h += Math.round(l.size * 1.45);
      c.width = W;
      c.height = h + pad;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.textBaseline = 'top';
      let y = pad;
      for (const l of lines) {
        ctx.font = font(l);
        ctx.fillStyle = l.color || '#111827';
        ctx.fillText(l.text, 0, y);
        y += Math.round(l.size * 1.45);
      }
      void ctx0;
      doc.addImage(c.toDataURL('image/png'), 'PNG', xMm, yMm, widthMm, (c.height / c.width) * widthMm, undefined, 'FAST');
    };

    drawText(
      [
        { text: 'Rollbook 관리자 로그인 QR', size: 54, bold: true },
        { text: `${who} · 한 장을 잘라서 로그인 화면 카메라에 비춰 주세요`, size: 34, color: '#6B7280' },
      ],
      20, 16, 170,
    );

    let y = 42;
    for (const mm of PRINT_SIZES_MM) {
      doc.addImage(dataUrl, 'PNG', 20, y, mm, mm, 'loginqr', 'FAST');
      doc.setDrawColor(200);
      doc.rect(20, y, mm, mm); // 자를 때 기준선
      doc.setFontSize(11);
      doc.setTextColor(17);
      doc.text(`${mm} mm`, 20 + mm + 8, y + mm / 2);
      y += mm + 14;
    }

    drawText(
      [
        { text: '인쇄할 때 "용지에 맞춤"을 끄고 100% 배율로 출력하세요.', size: 30, color: '#9CA3AF' },
        { text: 'QR 둘레의 흰 여백은 잘라내지 말고 남겨 두어야 인식이 잘 됩니다.', size: 30, color: '#9CA3AF' },
      ],
      20, y + 2, 170,
    );
    doc.save(filename.replace(/[\\/:*?"<>|]/g, '_'));
  }

  // QR 로그인 관리자 목록 + 지정 대상 드롭다운
  async function loadAdmins() {
    try {
      const [{ admins }, { members }] = await Promise.all([api('/api/auth/admins'), api('/api/members')]);
      membersCache = members;
      const adminIds = new Set(admins.map((a) => a.id));
      const candidates = members.filter((m) => !adminIds.has(m.id));
      $('adminMemberSel').innerHTML = candidates.length
        ? candidates.map((m) => `<option value="${m.id}">${esc(m.name)}${m.title ? ` ${esc(m.title)}` : ''}${m.dept ? ` (${esc(m.dept)})` : ''}</option>`).join('')
        : '<option value="">지정할 수 있는 인원이 없습니다</option>';
      $('adminList').innerHTML = admins.length
        ? `<table><thead><tr><th>이름</th><th>직함</th><th>부서</th><th style="width:230px;"></th></tr></thead><tbody>${admins
            .map((a) => `
              <tr>
                <td>${esc(a.name)}</td>
                <td>${esc(a.title)}</td>
                <td>${esc(a.dept)}</td>
                <td style="text-align:right; white-space:nowrap;">
                  <button class="small" data-qr-admin="${a.id}">QR 이미지</button>
                  <button class="small" data-pdf-admin="${a.id}">인쇄용 PDF</button>
                  <button class="small" data-scan-admin="${a.id}" data-name="${esc(a.name)}">가진 QR 재등록</button>
                  <button class="small" data-reissue-admin="${a.id}">새 QR 발급</button>
                  <button class="small ghost" data-del-admin="${a.id}">해제</button>
                </td>
              </tr>`)
            .join('')}</tbody></table>`
        : '<p class="muted">지정된 관리자가 없습니다.</p>';
    } catch (e) {
      toast(e.message, true);
    }
  }

  $('btnAddAdmin').addEventListener('click', async () => {
    const id = Number($('adminMemberSel').value);
    if (!id) return toast('명단에서 지정할 사람을 선택해 주세요.', true);
    try {
      const { admin } = await api('/api/auth/admins', { method: 'POST', body: JSON.stringify({ member_id: id }) });
      toast(`${admin.name}님을 관리자로 지정했습니다`);
      loadAdmins();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('adminList').addEventListener('click', async (e) => {
    const qrBtn = e.target.closest('button[data-qr-admin]');
    if (qrBtn) {
      try {
        const { admins } = await api('/api/auth/admins');
        const a = admins.find((x) => x.id === Number(qrBtn.dataset.qrAdmin));
        if (!a) return;
        await downloadLoginQr(`ROLLBOOK-LOGIN:${a.login_token}`, `관리자로그인_${a.name}.png`);
        toast(`${a.name}님의 로그인 QR 을 내려받았습니다`);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    const pdfBtn = e.target.closest('button[data-pdf-admin]');
    if (pdfBtn) {
      const old = pdfBtn.textContent;
      pdfBtn.disabled = true;
      pdfBtn.textContent = '만드는 중…';
      try {
        const { admins } = await api('/api/auth/admins');
        const a = admins.find((x) => x.id === Number(pdfBtn.dataset.pdfAdmin));
        if (a) {
          await downloadLoginQrPdf(`ROLLBOOK-LOGIN:${a.login_token}`, `${a.name}${a.title ? ` ${a.title}` : ''}`, `관리자로그인_${a.name}_인쇄용.pdf`);
          toast(`${a.name}님의 인쇄용 QR (30·40·50mm) 을 내려받았습니다`);
        }
      } catch (err) {
        toast(err.message, true);
      }
      pdfBtn.disabled = false;
      pdfBtn.textContent = old;
      return;
    }
    const reissueBtn = e.target.closest('button[data-reissue-admin]');
    if (reissueBtn) {
      if (!confirm('새 QR 을 발급하면 이 관리자의 기존 QR 은 즉시 쓸 수 없게 됩니다. 계속할까요?')) return;
      try {
        const d = await api(`/api/auth/admins/${reissueBtn.dataset.reissueAdmin}/reissue`, {
          method: 'POST', body: JSON.stringify({}),
        });
        await downloadLoginQrPdf(`ROLLBOOK-LOGIN:${d.login_token}`, d.name, `관리자로그인_${d.name}_인쇄용.pdf`);
        toast(`${d.name}님의 새 QR 을 발급하고 내려받았습니다`);
        loadAdmins();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    const scanBtn = e.target.closest('button[data-scan-admin]');
    if (scanBtn) {
      openQrScan(Number(scanBtn.dataset.scanAdmin), scanBtn.dataset.name);
      return;
    }

    const delBtn = e.target.closest('button[data-del-admin]');
    if (delBtn) {
      if (!confirm('관리자를 해제하면 이 사람의 로그인 QR 은 즉시 무효가 됩니다. 계속할까요?')) return;
      try {
        await api(`/api/auth/admins/${delBtn.dataset.delAdmin}`, { method: 'DELETE' });
        toast('관리자를 해제했습니다');
        loadAdmins();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  $('btnScannerQr').addEventListener('click', async () => {
    try {
      const { token } = await api('/api/auth/scanner-qr');
      if (!token) return toast('스캐너 QR 토큰이 없습니다. 재발급을 눌러 주세요.', true);
      await downloadLoginQrPdf(`ROLLBOOK-SCANNER:${token}`, '스캐너 PC 로그인용', '스캐너PC_로그인QR_인쇄용.pdf');
      toast('스캐너 로그인 QR (30·40·50mm) 을 내려받았습니다');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnResetScannerQr').addEventListener('click', async () => {
    if (!confirm('재발급하면 기존 스캐너 QR 이 무효가 되고, 로그인돼 있던 스캐너 PC 가 모두 풀립니다. 계속할까요?')) return;
    try {
      const { token } = await api('/api/auth/scanner-qr', { method: 'POST', body: JSON.stringify({}) });
      await downloadLoginQrPdf(`ROLLBOOK-SCANNER:${token}`, '스캐너 PC 로그인용', '스캐너PC_로그인QR_인쇄용.pdf');
      toast('새 스캐너 QR 을 발급하고 내려받았습니다');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnNewRecovery').addEventListener('click', async () => {
    if (!confirm('새 복구 코드를 발급하면 기존 코드는 쓸 수 없게 됩니다. 계속할까요?')) return;
    try {
      const { code } = await api('/api/auth/recovery-code', { method: 'POST', body: JSON.stringify({}) });
      const box = $('newRecoveryCode');
      box.textContent = code;
      box.classList.remove('hidden');
      toast('새 복구 코드입니다 — 지금 적어 두세요 (다시 볼 수 없습니다)');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnUnlock').addEventListener('click', async () => {
    try {
      await api('/api/auth/unlock', { method: 'POST', body: JSON.stringify({}) });
      toast('로그인 잠금을 모두 풀었습니다');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch { /* 무시 */ }
    location.href = '/login';
  });

  // ── 가진 QR 을 관리자에게 재등록 (카메라 스캔) ──────
  let qrScanStream = null;
  let qrScanning = false;
  let qrScanTargetId = null;

  function setScanState(msg, color = '') {
    const el = $('scanQrState');
    el.textContent = msg;
    el.style.color = color || 'var(--muted)';
  }

  async function closeQrScan() {
    qrScanning = false;
    if (qrScanStream) {
      qrScanStream.getTracks().forEach((t) => t.stop());
      qrScanStream = null;
    }
    $('scanQrModal').classList.add('hidden');
  }

  async function openQrScan(memberId, name) {
    qrScanTargetId = memberId;
    $('scanQrWho').textContent = `${name}님의 로그인 QR 로 등록합니다`;
    $('scanQrModal').classList.remove('hidden');
    $('scanQrOff').style.display = 'flex';
    $('scanQrOff').textContent = '카메라를 시작하는 중입니다…';
    setScanState('');
    try {
      qrScanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch {
      $('scanQrOff').textContent = '카메라를 열 수 없습니다. 브라우저의 카메라 권한을 허용해 주세요.';
      return;
    }
    const video = $('scanQrVideo');
    video.srcObject = qrScanStream;
    await video.play();
    const st = qrScanStream.getVideoTracks()[0]?.getSettings?.() || {};
    video.classList.toggle('mirror', st.facingMode !== 'environment');
    $('scanQrOff').style.display = 'none';
    setScanState('관리자 로그인 QR 을 비춰 주세요');
    qrScanLoop(video);
  }

  async function qrScanLoop(video) {
    const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const canvas = $('scanQrFrame');
    qrScanning = true;
    while (qrScanning) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      let value = null;
      if (w && h) {
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        if (detector) {
          try {
            const codes = await detector.detect(canvas);
            if (codes.length) value = codes[0].rawValue;
          } catch { /* jsQR 로 폴백 */ }
        }
        if (!value && window.jsQR) {
          const img = ctx.getImageData(0, 0, w, h);
          value = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
        }
      }
      if (!qrScanning) break;
      if (value) {
        setScanState('등록하는 중…');
        try {
          const d = await api(`/api/auth/admins/${qrScanTargetId}/token`, {
            method: 'POST', body: JSON.stringify({ payload: value }),
          });
          await closeQrScan();
          toast(`${d.name}님의 로그인 QR 을 재등록했습니다`);
          loadAdmins();
          return;
        } catch (err) {
          setScanState(err.message, 'var(--danger)');
          await new Promise((r) => setTimeout(r, 1600));
          if (!qrScanning) return;
          setScanState('관리자 로그인 QR 을 비춰 주세요');
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  $('btnScanQrCancel').addEventListener('click', closeQrScan);
  $('scanQrModal').addEventListener('click', (e) => { if (e.target === $('scanQrModal')) closeQrScan(); });

  // ── 초기 로드 ────────────────────────────────────────
  loadSheets();
})();
