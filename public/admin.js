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
              <td>${s.is_active ? '<span class="stag ok">사용 중</span>' : '<span class="stag">보관</span>'}</td>
              <td style="font-variant-numeric:tabular-nums;">${s.attended} / ${memberCount}명</td>
              <td class="right"><span class="row-actions" style="justify-content:flex-end;">
                <button class="small" data-act="view" data-id="${s.id}">현황</button>
                ${s.is_active
                  ? `<button class="small ghost" data-act="deactivate" data-id="${s.id}">사용 해제</button>`
                  : `<button class="small" data-act="activate" data-id="${s.id}">사용</button>`}
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
      if (b.dataset.act === 'view') {
        switchTab('status');
        await loadStatusTab(id);
      } else if (b.dataset.act === 'activate') {
        await api(`/api/sheets/${id}/activate`, { method: 'POST' });
        toast('스캐너가 이 출석부에 기록합니다');
        loadSheets();
      } else if (b.dataset.act === 'deactivate') {
        await api(`/api/sheets/${id}/deactivate`, { method: 'POST' });
        toast('사용 해제되었습니다');
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
      .map((s) => `<option value="${s.id}" ${s.id === chosen ? 'selected' : ''}>${esc(s.sheet_date)} · ${esc(s.title)}${s.is_active ? ' (사용 중)' : ''}</option>`)
      .join('');
    await renderStatus(chosen);
  }
  $('statusSheetSel').addEventListener('change', () => renderStatus(Number($('statusSheetSel').value)));

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
        <thead><tr><th>이름</th><th>부서</th><th>상태</th><th>출석 시각</th><th class="right">편집</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name)}</b></td>
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
        body: JSON.stringify({ name: $('memberName').value, dept: $('memberDept').value }),
      });
      $('memberName').value = '';
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
        <thead><tr><th>이름</th><th>부서</th><th>QR 코드 값</th><th class="right">관리</th></tr></thead>
        <tbody>
          ${members.map((m) => `
            <tr>
              <td><b>${esc(m.name)}</b></td>
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
          <label>부서 <input id="efDept" value="${esc(m.dept)}"></label>`,
          async () => {
            await api(`/api/members/${id}`, {
              method: 'PUT',
              body: JSON.stringify({ name: $('efName').value, dept: $('efDept').value }),
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
  const qrState = {
    dot: 'square',
    color: '#111827',
    logo: localStorage.getItem('rollbook-logo') || '',
  };
  let qr = null;

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
    owner.innerHTML = `<b>${esc(m.name)}${m.dept ? ` · ${esc(m.dept)}` : ''}</b><code>${esc(m.code)}</code>`;

    const options = {
      width: 480,
      height: 480,
      type: 'canvas',
      data: `ROLLBOOK:${m.code}`,
      margin: 8,
      qrOptions: { errorCorrectionLevel: 'H' },
      dotsOptions: { type: qrState.dot, color: qrState.color },
      cornersSquareOptions: {
        type: qrState.dot === 'square' ? 'square' : 'extra-rounded',
        color: qrState.color,
      },
      cornersDotOptions: { type: qrState.dot === 'square' ? 'square' : 'dot', color: qrState.color },
      backgroundOptions: { color: '#FFFFFF' },
      image: qrState.logo || undefined,
      imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35, hideBackgroundDots: true },
    };

    holder.innerHTML = '';
    qr = new QRCodeStyling(options);
    qr.append(holder);
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
        .map((m) => `<option value="${m.id}" ${m.id === chosen ? 'selected' : ''}>${esc(m.name)}${m.dept ? ` (${esc(m.dept)})` : ''}</option>`)
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

  function updateLogoUi() {
    const has = Boolean(qrState.logo);
    $('logoThumb').classList.toggle('hidden', !has);
    $('btnClearLogo').classList.toggle('hidden', !has);
    if (has) $('logoThumb').src = qrState.logo;
  }

  $('logoFile').addEventListener('change', () => {
    const file = $('logoFile').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      qrState.logo = reader.result;
      try { localStorage.setItem('rollbook-logo', qrState.logo); } catch { /* 큰 파일이면 저장 생략 */ }
      updateLogoUi();
      renderQr();
    };
    reader.readAsDataURL(file);
  });

  $('btnClearLogo').addEventListener('click', () => {
    qrState.logo = '';
    $('logoFile').value = '';
    try { localStorage.removeItem('rollbook-logo'); } catch {}
    updateLogoUi();
    renderQr();
  });

  $('btnDownloadQr').addEventListener('click', () => {
    const m = currentMember();
    if (!qr || !m) return;
    qr.download({ name: `rollbook-qr-${m.name}`, extension: 'png' });
  });

  // ── 초기 로드 ────────────────────────────────────────
  loadSheets();
})();
