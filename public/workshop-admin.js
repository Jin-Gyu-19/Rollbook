// 워크샵 관리 화면 전용 스크립트 — /workshop/admin 에서만 불린다.
// (관리자만 볼 수 있는 주소라서 이 파일 자체도 로그인 없이는 받아지지 않는다.)
// 다른 사람이 만든 public/workshop/index.html 은 손대지 않고, 이 파일이
// 그 위에 관리자 줄과 편집기를 얹는다. 편집기가 고치는 것은 화면에 이미
// 올라와 있는 자료(PEOPLE · PROGRAM · DINNER)의 사본이고, 저장하면 새 버전으로
// 데이터베이스에 쌓여 참석자 화면에 그대로 반영된다.
(function () {
  'use strict';

  // 화면에 보이는 시각은 보는 기기의 시간대와 상관없이 늘 한국시간(KST).
  // 서버에 쌓이는 값은 UTC(...Z) 라서 읽을 때 여기서 한 번만 바꾼다.
  var KST_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  function fmtKst(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var t = {};
    KST_FMT.formatToParts(d).forEach(function (x) { t[x.type] = x.value; });
    return t.year + '-' + t.month + '-' + t.day + ' ' + t.hour + ':' + t.minute;
  }

  // 원본 앱의 색·글꼴 변수(--surface, --accent, --radius …)를 그대로 써서 한 앱처럼 보이게 한다.
  // 다크 모드도 원본 변수를 따라 저절로 맞춰진다.
  // 편집 화면은 참석자 화면의 '그 화면' 을 그대로 쓴다 — 원본 앱의 클래스(.g-card,
  // .program-day-card, .tabs …)로 똑같이 그리고, 고칠 수 있는 글자에만 옅은 밑줄을 둔다.
  var CSS = [
    /* 편집 중에는 참석자 화면 대신 같은 모양의 편집본을 보여 준다 */
    '.rb-editing .wrap > .tabs, .rb-editing .wrap > .panel, .rb-editing .admin-toggle-row, .rb-editing #adminPanel { display: none !important; }',
    '.rbed[hidden] { display: none; }',

    /* 고칠 수 있는 글자 */
    '[data-ed] { display: inline-block; min-width: 18px; border-radius: 5px; padding: 1px 4px; margin: -1px -4px;',
    '  box-shadow: inset 0 -1px 0 var(--accent-soft-border); white-space: pre-wrap; cursor: text; }',
    '[data-ed]:hover { background: var(--accent-soft); }',
    '[data-ed]:focus { outline: 2px solid var(--accent); background: var(--surface); box-shadow: none; }',
    '[data-ed]:empty::before { content: attr(data-ph); color: var(--text-muted); }',
    'td.speaker [data-ed], td.dept [data-ed], td.time [data-ed], .g-member [data-ed], .g-num [data-ed] { white-space: nowrap; }',
    '.program-hero [data-ed] { box-shadow: inset 0 -1px 0 rgba(255,255,255,.6); }',
    '.program-hero [data-ed]:hover { background: rgba(255,255,255,.18); }',
    '.program-day-card-head [data-ed] { box-shadow: inset 0 -1px 0 rgba(255,255,255,.55); }',
    '.program-day-card-head [data-ed]:hover { background: rgba(255,255,255,.2); }',

    /* 편집용 작은 단추 */
    '.ed-ctl { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }',
    '.ed-btn { width: 22px; height: 22px; padding: 0; line-height: 1; border: 1px solid var(--border); border-radius: 6px;',
    '  background: var(--surface); color: var(--text-muted); font: 700 11px/1 inherit; cursor: pointer; }',
    '.ed-btn:hover { background: var(--accent-soft); border-color: var(--accent-soft-border); color: var(--accent-strong); }',
    '.ed-btn.del:hover { background: #FEF2F2; border-color: #FCA5A5; color: #C81330; }',
    '.ed-btn.on { background: var(--highlight-bg); border-color: var(--highlight-border); color: var(--highlight-text); }',
    '.ed-num { width: 34px; text-align: center; padding: 2px 3px; border: 1px solid var(--border); border-radius: 6px;',
    '  background: var(--surface); color: var(--text); font: 600 11.5px inherit; }',
    '.ed-add { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 6px 12px; border: 1px dashed var(--accent-soft-border);',
    '  border-radius: 9px; background: var(--accent-soft); color: var(--accent-strong); font: 700 12px inherit; cursor: pointer; }',
    '.ed-add:hover { border-style: solid; }',
    '.ed-foot { padding: 0 14px 12px; }',
    '.ed-tool { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }',
    '.ed-tool input[type=text] { flex: 1 1 150px; min-width: 0; font-family: inherit; font-size: 14px; padding: 9px 11px;',
    '  border-radius: 10px; border: 1.5px solid var(--border); background: var(--surface); color: var(--text); outline: none; }',
    '.ed-tool input[type=text]:focus { border-color: var(--accent); }',
    '.ed-tool .ed-add { margin-top: 0; }',
    '.ed-tool .cnt { flex-basis: 100%; color: var(--text-muted); font-size: 12px; }',
    '.ed-hint { margin: 0 0 14px; color: var(--text-muted); font-size: 12.5px; line-height: 1.6; }',

    /* 편집 중임을 알리는 줄 (참석자 화면과 헷갈리지 않게) */
    '.rbed-bar { position: sticky; top: 0; z-index: 900; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;',
    '  margin: 0 0 14px; padding: 10px 12px; background: var(--accent-soft); border: 1px solid var(--accent-soft-border);',
    '  border-radius: 12px; font-size: 12.5px; color: var(--accent-strong); }',
    '.rbed-bar b { font-size: 13px; }',
    '.rbed-bar .rbed-msg { color: var(--text-muted); }',
    '.rbed-bar .rbed-msg.err { color: #C81330; }',
    '.rbed-bar .rbed-msg.ok { color: #15803D; }',
    '.rbed-bar .sp { flex: 1; }',
    '.rbed-bar button { font: 700 12.5px inherit; padding: 8px 14px; border-radius: 9px; cursor: pointer;',
    '  border: 1px solid var(--border); background: var(--surface); color: var(--text); }',
    '.rbed-bar .go { background: var(--accent); border-color: var(--accent); color: #fff; }',
    '.rbed-bar .go:disabled { opacity: .5; cursor: not-allowed; }',

    /* 일정표·조 카드에 편집 열을 더한 자리 */
    '.program-schedule td.ed-cell { width: 1%; padding-left: 4px; padding-right: 8px; text-align: right; }',
    '.program-day-card-head .program-day-name { margin-right: auto; }',
    '.program-day-card-head .program-day-date { margin-right: 10px; }',
    '.rbed-body > .ed-add { margin-bottom: 22px; }',
    '.program-brand > .ed-add { margin-bottom: 18px; }',
    '.program-day-card-head .ed-btn { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.35); color: #fff; }',
    '.program-day-card-head .ed-btn:hover { background: rgba(255,255,255,.32); color: #fff; }',
    '.g-head .ed-ctl { margin-left: 8px; }',
    '.g-member { align-items: center; }',
    '.g-member .ed-ctl { margin-left: 6px; }',
    '.g-member-meta { display: inline-flex; align-items: center; gap: 4px; }',
    '.ed-btn.att { font-size: 13px; }',
    '.ed-btn.att.on { background: var(--p-red, #ED1A3B); border-color: var(--p-red, #ED1A3B); color: #fff; }',
    '.program-schedule td.content .attend-badge { margin-right: 5px; }',

    /* ── 적용 내역 · 실패 원인 ── */
    '.rbrep { position: fixed; inset: 0; z-index: 4000; background: rgba(18,48,73,.45); display: flex;',
    '  align-items: center; justify-content: center; padding: 24px; font-size: 13.5px; line-height: 1.6;',
    '  font-family: "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Malgun Gothic", sans-serif; color: var(--text); }',
    '.rbrep[hidden] { display: none; }',
    '.rbrep button { font-family: inherit; }',
    '.rbrep .card { width: min(520px, 100%); max-height: 88vh; overflow: auto; background: var(--surface); color: var(--text);',
    '  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 22px 24px 18px; }',
    '.rbrep h3 { margin: 0 0 2px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }',
    '.rbrep .when { color: var(--text-muted); font-size: 12.5px; margin: 0 0 16px; }',
    '.rbrep dl { display: grid; grid-template-columns: 76px 1fr; gap: 6px 12px; margin: 0 0 14px; }',
    '.rbrep dt { color: var(--text-muted); font-size: 12.5px; font-weight: 700; }',
    '.rbrep dd { margin: 0; }',
    '.rbrep .sec { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }',
    '.rbrep .sec > b { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 800; }',
    '.rbrep .line { display: flex; gap: 8px; margin-bottom: 5px; align-items: baseline; }',
    '.rbrep .line .k { flex: none; width: 84px; color: var(--text-muted); font-size: 12.5px; font-weight: 700; }',
    '.rbrep .line .v { color: var(--text); font-weight: 600; }',
    '.rbrep .names { color: var(--text-muted); font-size: 12.5px; font-weight: 400; }',
    '.rbrep .none { color: var(--text-muted); }',
    '.rbrep .why { background: #FEF2F2; border: 1px solid #FECACA; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; color: #16212b; }',
    '.rbrep .why .k { color: #C81330; font-size: 12px; font-weight: 800; }',
    '.rbrep .why .v { margin-bottom: 8px; word-break: break-word; }',
    '.rbrep .todo { background: var(--surface-alt); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; color: var(--text); }',
    '.rbrep .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }',
    '.rbrep .btns button { padding: 10px 16px; border: 1px solid var(--accent); border-radius: 10px; background: var(--accent); color: #fff;',
    '  font-size: 13px; font-weight: 700; cursor: pointer; }',
    '.rbrep .btns button.ghost { background: var(--surface-alt); color: var(--text); border-color: var(--border); }',
  ].join('\n');

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  var clone = function (v) { return JSON.parse(JSON.stringify(v == null ? null : v)); };
  // 원본 앱이 문서 최상단에 const 로 선언한 값들 — 같은 문서의 스크립트라 이름으로 바로 읽힌다
  var readPeople = function () { return typeof PEOPLE !== 'undefined' && Array.isArray(PEOPLE) ? PEOPLE : []; };
  var readDinner = function () { return typeof DINNER !== 'undefined' && Array.isArray(DINNER) ? DINNER : []; };
  var readProgram = function () { return typeof PROGRAM !== 'undefined' && PROGRAM ? PROGRAM : null; };

  document.head.appendChild(el('style', null, CSS));

  // ── 원본 관리 패널을 펼쳐 둔다 (원본은 맨 아래 '관리자' 글자를 눌러야 열린다)
  var panel = $('adminPanel');
  if (panel) panel.hidden = false;
  var link = $('adminLinkBtn');
  if (link) link.hidden = true;

  // ── 지난 버전 ────────────────────────────────────────
  var listBtn = $('rbPubList');
  var box = $('rbPubBox');
  var msg = $('rbPubMsg');
  var vers = $('rbPubVers');

  function say(t, k) {
    box.hidden = false;
    msg.textContent = t;
    msg.className = 'msg' + (k ? ' ' + k : '');
  }

  listBtn.addEventListener('click', async function () {
    if (!box.hidden) { box.hidden = true; vers.innerHTML = ''; msg.textContent = ''; return; }
    box.hidden = false;
    msg.textContent = '';
    try {
      var r = await fetch('/api/workshop/versions');
      var d = await r.json();
      if (!d.versions || !d.versions.length) {
        vers.innerHTML = '<p>아직 올린 버전이 없습니다. 지금은 앱 파일에 들어 있는 원래 자료를 쓰고 있습니다.</p>';
        return;
      }
      var onFile = !d.versions.some(function (v) { return v.is_active; });
      vers.innerHTML = '<table>' + d.versions.map(function (v) {
        return '<tr><td>' + (v.is_active ? '● 사용 중' : '') + '</td><td>버전 ' + v.id + '</td>'
          + '<td>' + fmtKst(v.created_at) + '</td>'
          + '<td>' + v.people_count + '명 · ' + v.group_count + '조</td><td>'
          + (v.is_active ? '' : '<button type="button" data-id="' + v.id + '">이 버전으로</button>') + '</td></tr>';
      }).join('')
        + '<tr><td>' + (onFile ? '● 사용 중' : '') + '</td><td colspan="3">앱 파일에 들어 있는 원래 자료'
        + ' <span style="color:var(--text-muted)">(개발자가 새 파일을 준 직후에 씁니다)</span></td><td>'
        + (onFile ? '' : '<button type="button" data-id="0">이 자료로</button>') + '</td></tr></table>';
      vers.querySelectorAll('button[data-id]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          var r2 = await fetch('/api/workshop/activate', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: Number(btn.dataset.id) }),
          });
          var d2 = await r2.json();
          if (r2.ok) {
            say(btn.dataset.id === '0'
              ? '앱 파일에 들어 있는 원래 자료를 쓰도록 했습니다. 잠시 후 새로고침됩니다.'
              : '버전 ' + btn.dataset.id + ' 로 되돌렸습니다. 잠시 후 새로고침됩니다.', 'ok');
            setTimeout(function () { location.reload(); }, 1200);
          } else { say(d2.error || '되돌리지 못했습니다.', 'err'); btn.disabled = false; }
        });
      });
    } catch (e) { say(e.message, 'err'); }
  });

  // 앱 파일에 다른 자료가 들어 있을 때 뜨는 알림 — 한 번 눌러 파일 자료로 바꾼다
  var useFile = $('rbUseFile');
  if (useFile) {
    useFile.addEventListener('click', async function () {
      useFile.disabled = true;
      useFile.textContent = '바꾸는 중…';
      try {
        var r = await fetch('/api/workshop/activate', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 0 }),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || '바꾸지 못했습니다.');
        if (d.diff) {
          // 무엇이 달라졌는지 보여 주고, 닫으면 새로고침
          useFile.textContent = '바뀌었습니다';
          showDone(d);
        } else {
          useFile.textContent = '바뀌었습니다 — 새로고침 중';
          setTimeout(function () { location.reload(); }, 800);
        }
      } catch (e) {
        useFile.disabled = false;
        useFile.textContent = '앱 파일의 자료로 바꾸기';
        say(e.message, 'err');
      }
    });
  }

  // ── 직접 편집 ────────────────────────────────────────
  var draft = null;      // { PROGRAM, PEOPLE, DINNER }
  var labels = { PEOPLE: {}, DINNER: {} }; // 조 번호 → 조 이름
  var dirty = false;
  var tab = 'program';

  var ui = el('div', 'rbed');
  ui.hidden = true;
  ui.innerHTML =
    '<div class="rbed-bar"><b>편집 중</b>'
    + '<span>참석자에게 보이는 화면 그대로입니다. 밑줄 친 글자를 눌러 고치세요.</span>'
    + '<span class="sp"></span><span class="rbed-msg"></span>'
    + '<button type="button" class="close">닫기</button>'
    + '<button type="button" class="go">저장하고 참석자 화면에 반영</button></div>'
    + '<div class="tabs rbed-tabs">'
    + '<button type="button" class="tab-btn" data-t="program">Program</button>'
    + '<button type="button" class="tab-btn" data-t="people">Grand Hall</button>'
    + '<button type="button" class="tab-btn" data-t="dinner">석식</button></div>'
    + '<div class="rbed-body"></div>';
  // 참석자 화면과 같은 자리(.wrap 안)에 놓는다
  var wrap = document.querySelector('.wrap') || document.body;
  if (panel) wrap.insertBefore(ui, panel); else wrap.appendChild(ui);

  var body = ui.querySelector('.rbed-body');
  var note = ui.querySelector('.rbed-msg');
  var saveBtn = ui.querySelector('.go');

  function tell(t, k) { note.textContent = t || ''; note.className = 'rbed-msg' + (k ? ' ' + k : ''); }
  function touch() { dirty = true; tell('저장하지 않은 수정이 있습니다.'); }

  function loadDraft() {
    draft = {
      PROGRAM: clone(readProgram()) || { title: '', dateRange: '', days: [], lineup: [] },
      PEOPLE: clone(readPeople()),
      DINNER: clone(readDinner()),
    };
    if (!Array.isArray(draft.PROGRAM.days)) draft.PROGRAM.days = [];
    if (!Array.isArray(draft.PROGRAM.lineup)) draft.PROGRAM.lineup = [];
    labels = { PEOPLE: {}, DINNER: {} };
    ['PEOPLE', 'DINNER'].forEach(function (kind) {
      draft[kind].forEach(function (p) {
        if (p.groupLabel) labels[kind][p.group] = p.groupLabel;
      });
    });
  }

  // 값을 바로 draft 에 되돌려 쓰는 입력칸
  // 글자를 그 자리에서 고친다 — 참석자 화면에 보이는 그 모양 그대로
  function edit(obj, key, cls, placeholder) {
    var n = el('span', cls || null);
    n.setAttribute('data-ed', '');
    if (placeholder) n.setAttribute('data-ph', placeholder);
    try { n.contentEditable = 'plaintext-only'; } catch (e) { n.contentEditable = 'true'; }
    if (n.contentEditable !== 'plaintext-only') n.contentEditable = 'true';
    n.textContent = obj[key] == null ? '' : String(obj[key]);
    var last = n.textContent;
    n.addEventListener('input', function () {
      var v = n.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
      if (v === last) return;
      last = v;
      obj[key] = v;
      touch();
    });
    // 서식 붙여넣기를 막는다 (글자만 들어오게)
    n.addEventListener('paste', function (e) {
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
    return n;
  }

  function edBtn(txt, title, cls, fn) {
    var b = el('button', 'ed-btn' + (cls ? ' ' + cls : ''), txt);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  }
  function ctl() { return el('span', 'ed-ctl'); }
  function addBtn(txt, fn) {
    var b = el('button', 'ed-add', txt);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function move(arr, i, d) {
    var j = i + d;
    if (j < 0 || j >= arr.length) return false;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    return true;
  }

  // ── Program 탭 — 참석자 화면의 Program 을 그대로 그리고 글자만 고친다 ──
  function renderProgram() {
    var P = draft.PROGRAM;

    var brand = el('div', 'program-brand');
    var hero = el('div', 'program-hero');
    var hc = el('div', 'program-hero-content');
    var year = (P.dateRange || '').match(/\d{4}/);
    if (year) hc.appendChild(el('p', 'program-eyebrow', year[0]));
    var h2 = el('h2', 'program-hero-title');
    h2.appendChild(edit(P, 'title', null, '프로그램 제목'));
    hc.appendChild(h2);
    var pd = el('p', 'program-hero-date');
    pd.appendChild(edit(P, 'dateRange', null, '기간'));
    hc.appendChild(pd);
    hero.appendChild(hc);
    brand.appendChild(hero);

    brand.appendChild(el('h3', 'program-section-head', '일정 안내'));
    var grid = el('div', 'program-day-grid');
    P.days.forEach(function (day, di) {
      if (!Array.isArray(day.rows)) day.rows = [];
      // 원본은 label 을 공백 두 칸 이상으로 나눠 왼쪽·오른쪽에 보여 준다
      var parts = String(day.label || '').split(/\s{2,}/).filter(Boolean);
      var lab = { name: parts[0] || String(day.label || ''), date: parts.length > 1 ? parts[parts.length - 1] : '' };
      var join = function () { day.label = lab.date ? lab.name + '   ' + lab.date : lab.name; };
      var card = el('div', 'program-day-card');
      var head = el('div', 'program-day-card-head');
      var nameEl = edit(lab, 'name', null, '이름');
      var dateEl = edit(lab, 'date', null, '날짜');
      nameEl.addEventListener('input', join);
      dateEl.addEventListener('input', join);
      var n1 = el('span', 'program-day-name'); n1.appendChild(nameEl);
      var n2 = el('span', 'program-day-date'); n2.appendChild(dateEl);
      head.appendChild(n1);
      head.appendChild(n2);
      var hc2 = ctl();
      hc2.appendChild(edBtn('✕', '이 일자 지우기', 'del', function () {
        if (!confirm('이 일자를 통째로 지울까요?')) return;
        P.days.splice(di, 1); touch(); redraw();
      }));
      head.appendChild(hc2);
      card.appendChild(head);

      var tb = el('table', 'program-schedule');
      day.rows.forEach(function (row, ri) {
        var tr = el('tr');
        var noteOnly = !row.time;
        if (noteOnly) tr.className = 'alert';
        var t1 = el('td', 'time'); t1.appendChild(edit(row, 'time', null, '시간'));
        var t2 = el('td', 'content');
        // 출석체크 표시는 참석자 화면과 똑같이 보여 주고(켜져 있을 때만), 켜고 끄기는 줄 끝 단추로
        if (row.attend) {
          var badge = el('span', 'attend-badge');
          badge.innerHTML = '출석<br>체크';
          t2.appendChild(badge);
        }
        t2.appendChild(edit(row, 'content', noteOnly ? 'alert-text' : null, '내용'));
        var t3 = el('td', 'note'); t3.appendChild(edit(row, 'note', null, '비고'));
        var t4 = el('td', 'ed-cell');
        var c = ctl();
        c.appendChild(edBtn('●', '출석체크 표시 켜기 / 끄기', 'att' + (row.attend ? ' on' : ''), function () {
          row.attend = !row.attend; touch(); redraw(true);
        }));
        c.appendChild(edBtn('↑', '위로', '', function () { if (move(day.rows, ri, -1)) { touch(); redraw(true); } }));
        c.appendChild(edBtn('↓', '아래로', '', function () { if (move(day.rows, ri, 1)) { touch(); redraw(true); } }));
        c.appendChild(edBtn('✕', '이 줄 지우기', 'del', function () { day.rows.splice(ri, 1); touch(); redraw(true); }));
        t4.appendChild(c);
        [t1, t2, t3, t4].forEach(function (td) { tr.appendChild(td); });
        tb.appendChild(tr);
      });
      card.appendChild(tb);
      var foot = el('div', 'ed-foot');
      foot.appendChild(addBtn('+ 항목 추가', function () {
        day.rows.push({ time: '', content: '', note: '', attend: false }); touch(); redraw(true);
      }));
      card.appendChild(foot);
      grid.appendChild(card);
    });
    brand.appendChild(grid);
    brand.appendChild(addBtn('+ 일자 추가', function () {
      P.days.push({ label: 'Day ' + (P.days.length + 1) + '   ', rows: [] }); touch(); redraw(true);
    }));

    brand.appendChild(el('h3', 'program-section-head', 'AI Workshop 세부 프로그램'));
    P.lineup.forEach(function (g, gi) {
      if (!Array.isArray(g.items)) g.items = [];
      var card = el('div', 'lineup-card');
      var head = el('div', 'lineup-card-head');
      var nm = el('span', 'name');
      nm.appendChild(edit(g, 'category', null, '분류 이름'));
      head.appendChild(nm);
      var hc3 = ctl();
      hc3.appendChild(edBtn('✕', '이 분류 지우기', 'del', function () {
        if (!confirm('이 분류를 지울까요?')) return;
        P.lineup.splice(gi, 1); touch(); redraw(true);
      }));
      head.appendChild(hc3);
      card.appendChild(head);
      var tb = el('table', 'lineup');
      g.items.forEach(function (it, ii) {
        var tr = el('tr');
        var c1 = el('td', 'speaker'); c1.appendChild(edit(it, 'speaker', null, '발표자'));
        var c2 = el('td', 'dept'); c2.appendChild(edit(it, 'dept', null, '본부'));
        var c3 = el('td', 'topic'); c3.appendChild(edit(it, 'topic', null, '주제'));
        var c4 = el('td', 'ed-cell');
        var c = ctl();
        c.appendChild(edBtn('↑', '위로', '', function () { if (move(g.items, ii, -1)) { touch(); redraw(true); } }));
        c.appendChild(edBtn('↓', '아래로', '', function () { if (move(g.items, ii, 1)) { touch(); redraw(true); } }));
        c.appendChild(edBtn('✕', '이 줄 지우기', 'del', function () { g.items.splice(ii, 1); touch(); redraw(true); }));
        c4.appendChild(c);
        [c1, c2, c3, c4].forEach(function (td) { tr.appendChild(td); });
        tb.appendChild(tr);
      });
      card.appendChild(tb);
      var foot = el('div', 'ed-foot');
      foot.appendChild(addBtn('+ 발표 추가', function () {
        g.items.push({ dept: '', speaker: '', topic: '', duration: '' }); touch(); redraw(true);
      }));
      card.appendChild(foot);
      brand.appendChild(card);
    });
    brand.appendChild(addBtn('+ 분류 추가', function () {
      P.lineup.push({ category: '새 분류', items: [] }); touch(); redraw(true);
    }));
    body.appendChild(brand);
  }

  // ── Grand Hall / 석식 탭 — 참석자 화면의 '전체 조 보기' 를 그대로 그린다 ──
  var filterText = { PEOPLE: '', DINNER: '' };

  function renderRoster(kind) {
    var list = draft[kind];
    var isDinner = kind === 'DINNER';

    body.appendChild(el('p', 'ed-hint',
      (isDinner ? '석식(BBQ) 조배정입니다. ' : 'Grand Hall 조배정입니다. ')
      + '이름·직급·본부를 눌러 바로 고치고, 조를 옮길 때는 줄 끝의 숫자를 바꾸세요. '
      + '★ 는 AI 활용 유경험자 표시로, 조배정 계산에만 쓰이고 참석자 화면에는 나오지 않습니다.'));

    var tool = el('div', 'ed-tool');
    var q = el('input');
    q.type = 'text';
    q.placeholder = '이름·직급·본부로 좁혀 보기';
    q.value = filterText[kind];
    q.addEventListener('input', function () { filterText[kind] = q.value; redraw(true); });
    tool.appendChild(q);
    tool.appendChild(addBtn('+ 조 추가', function () {
      var max = 0;
      list.forEach(function (p2) { max = Math.max(max, Number(p2.group) || 0); });
      list.push({ name: '', pos: '', gender: '', hub: '', dept: '', ai: false, group: max + 1 });
      filterText[kind] = '';
      touch(); redraw();
    }));
    body.appendChild(tool);

    // 조별로 묶는다 (참석자 화면과 같은 순서)
    var groups = {};
    list.forEach(function (p2, i) {
      var g = Number(p2.group) || 0;
      (groups[g] = groups[g] || []).push({ p: p2, i: i });
    });
    var nums = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    var needle = filterText[kind].trim();
    var shown = 0;

    nums.forEach(function (gn) {
      var members = groups[gn];
      var hit = needle ? members.filter(function (m) {
        return [m.p.name, m.p.pos, m.p.hub, m.p.dept].join(' ').indexOf(needle) !== -1;
      }) : members;
      if (needle && !hit.length) return;
      shown += hit.length;

      var card = el('div', 'g-card');
      var head = el('div', 'g-head');
      var num = el('span', 'g-num');
      // 조 이름 — 비우면 참석자 화면에 '1조' 처럼 번호로 나간다
      var labelBox = { v: labels[kind][gn] || (gn + '조') };
      var ne = edit(labelBox, 'v', null, gn + '조');
      ne.addEventListener('input', function () {
        var v = String(labelBox.v || '').trim();
        labels[kind][gn] = (v === '' || v === gn + '조') ? '' : v;
      });
      num.appendChild(ne);
      head.appendChild(num);
      head.appendChild(el('span', 'g-count', members.length + '명'));
      var hc = ctl();
      hc.appendChild(edBtn('+', '이 조에 인원 추가', '', function () {
        list.push({ name: '', pos: '', gender: '', hub: '', dept: '', ai: false, group: gn });
        filterText[kind] = '';
        touch(); redraw();
      }));
      hc.appendChild(edBtn('✕', '이 조를 통째로 지우기', 'del', function () {
        if (!confirm(gn + '조 ' + members.length + '명을 모두 지울까요?')) return;
        var keep = [];
        list.forEach(function (p2) { if ((Number(p2.group) || 0) !== gn) keep.push(p2); });
        draft[kind] = keep;
        touch(); redraw();
      }));
      head.appendChild(hc);
      card.appendChild(head);

      var bodyEl = el('div', 'g-body open');
      hit.forEach(function (m) {
        var row = el('div', 'g-member');
        var nameEl = el('span', 'g-member-name');
        nameEl.appendChild(edit(m.p, 'name', null, '이름'));
        var star = edBtn('★', 'AI 활용 유경험자 (조배정 계산용 · 참석자 화면에는 안 보임)', m.p.ai ? 'on' : '', function () {
          m.p.ai = !m.p.ai;
          star.classList.toggle('on', m.p.ai);
          touch();
        });
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(star);
        row.appendChild(nameEl);

        var meta = el('span', 'g-member-meta');
        meta.appendChild(edit(m.p, 'pos', null, '직급'));
        meta.appendChild(document.createTextNode(' · '));
        meta.appendChild(edit(m.p, 'hub', null, '본부'));
        row.appendChild(meta);

        var c = ctl();
        var gi = el('input', 'ed-num');
        gi.type = 'number';
        gi.min = '1';
        gi.title = '조 옮기기';
        gi.value = m.p.group;
        gi.addEventListener('change', function () {
          var v = Number(gi.value);
          if (!v || v < 1) v = 1;
          m.p.group = v;
          touch(); redraw(true);
        });
        c.appendChild(gi);
        c.appendChild(edBtn('✕', '이 사람 지우기', 'del', function () {
          var idx = draft[kind].indexOf(m.p);
          if (idx !== -1) draft[kind].splice(idx, 1);
          touch(); redraw(true);
        }));
        row.appendChild(c);
        bodyEl.appendChild(row);
      });
      card.appendChild(bodyEl);
      body.appendChild(card);
    });

    var cnt = el('p', 'ed-hint');
    cnt.style.marginTop = '12px';
    cnt.textContent = needle
      ? shown + '명만 보이는 중 — 검색칸을 비우면 전체가 나옵니다.'
      : list.length + '명 · ' + nums.length + '개 조';
    body.appendChild(cnt);
  }

  var keepScroll = 0;
  function redraw(keep) {
    if (keep) keepScroll = window.scrollY;
    body.innerHTML = '';
    if (tab === 'program') renderProgram();
    else if (tab === 'people') renderRoster('PEOPLE');
    else renderRoster('DINNER');
    ui.querySelectorAll('.rbed-tabs .tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.t === tab);
    });
    if (keep) window.scrollTo(0, keepScroll);
  }

  ui.querySelectorAll('.rbed-tabs .tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { tab = b.dataset.t; redraw(); });
  });
  ui.querySelector('.close').addEventListener('click', function () {
    if (dirty && !confirm('저장하지 않은 수정이 있습니다. 그냥 닫을까요?')) return;
    ui.hidden = true;
    document.body.classList.remove('rb-editing');
  });

  // 저장할 자료를 만든다 — 조 인원수·통계는 여기서 다시 센다
  function tidy(kind) {
    var out = [];
    draft[kind].forEach(function (p) {
      var name = String(p.name || '').trim();
      if (!name) return;
      var g = Number(p.group);
      if (!g || g < 1) g = 1;
      out.push({
        name: name,
        pos: String(p.pos || '').trim(),
        gender: p.gender || '',
        hub: String(p.hub || '').trim(),
        dept: String(p.dept || '').trim(),
        ai: !!p.ai,
        group: g,
        groupSize: 0,
        groupLabel: (labels[kind][g] || '').trim() || null,
      });
    });
    var size = {};
    out.forEach(function (p) { size[p.group] = (size[p.group] || 0) + 1; });
    out.forEach(function (p) { p.groupSize = size[p.group]; });
    // 석식 명단은 원래 조 이름 칸이 없다 — 이름을 붙였을 때만 넣어 원본 모양을 지킨다
    if (kind === 'DINNER') out.forEach(function (p) { if (!p.groupLabel) delete p.groupLabel; });
    return out;
  }

  saveBtn.addEventListener('click', async function () {
    var people = tidy('PEOPLE');
    if (!people.length) { tell('명단이 비어 있어 저장할 수 없습니다.', 'err'); return; }
    var dinner = tidy('DINNER');
    var groupCount = Object.keys(people.reduce(function (a, p) { a[p.group] = 1; return a; }, {})).length;
    var payload = {
      META: {
        total: people.length,
        groupCount: groupCount,
        aiTotal: people.filter(function (p) { return p.ai; }).length,
        buildDate: fmtKst(Date.now()).slice(0, 10), // 한국시간 기준 날짜
      },
      PEOPLE: people,
      PROGRAM: draft.PROGRAM,
      DINNER: dinner,
    };
    saveBtn.disabled = true;
    tell('저장하는 중…');
    var r;
    try {
      r = await fetch('/api/workshop/save', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch (e) {
      tell('서버에 연결하지 못했습니다.', 'err');
      saveBtn.disabled = false;
      showFail({ step: '전송', error: '서버에 연결하지 못했습니다.', detail: e.message, status: 0 });
      return;
    }
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      tell(d.error || '저장하지 못했습니다.', 'err');
      saveBtn.disabled = false;
      showFail({ step: d.step || '저장', error: d.error || ('서버가 ' + r.status + ' 로 응답했습니다.'),
                 detail: d.detail || '', status: r.status });
      return;
    }
    dirty = false;
    tell('반영되었습니다 (버전 ' + d.id + ').', 'ok');
    showDone(d);
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ── 적용 내역 · 실패 원인 ────────────────────────────
  // 엑셀 게시(원본 앱의 '게시하기')와 직접 편집이 함께 쓴다.
  var rep = el('div', 'rbrep');
  rep.hidden = true;
  rep.innerHTML = '<div class="card"></div>';
  document.body.appendChild(rep);
  var repCard = rep.querySelector('.card');

  function closeReport(reload) {
    rep.hidden = true;
    if (reload) location.reload();
  }
  rep.addEventListener('click', function (e) { if (e.target === rep) closeReport(rep.dataset.reload === '1'); });

  function line(k, v, cls) {
    var w = el('div', 'line');
    w.appendChild(el('span', 'k', k));
    w.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v));
    return w;
  }
  function names(list, total) {
    if (!list || !list.length) return '';
    var t = list.join(', ');
    if (total > list.length) t += ' 외 ' + (total - list.length) + '명';
    return t;
  }
  function diffSection(title, d, unit) {
    var box = el('div', 'sec');
    box.appendChild(el('b', null, title));
    if (!d) {
      box.appendChild(el('div', 'none', '처음 올린 자료라 견줄 이전 버전이 없습니다.'));
      return box;
    }
    if (!d.addedCount && !d.removedCount && !d.movedCount && !d.changedCount) {
      box.appendChild(el('div', 'none', unit + ' 변동 없음 (' + d.kept + '명 그대로)'));
      return box;
    }
    var add = line('새로 들어옴', d.addedCount + '명');
    if (d.addedCount) add.appendChild(el('span', 'names', ' — ' + names(d.added, d.addedCount)));
    box.appendChild(add);
    var rm = line('빠짐', d.removedCount + '명');
    if (d.removedCount) rm.appendChild(el('span', 'names', ' — ' + names(d.removed, d.removedCount)));
    box.appendChild(rm);
    var mv = line('조가 바뀜', d.movedCount + '명');
    if (d.movedCount) {
      mv.appendChild(el('span', 'names', ' — ' + names(d.moved.map(function (m) {
        return m.name + ' ' + m.from + '→' + m.to;
      }), d.movedCount)));
    }
    box.appendChild(mv);
    if (d.changedCount) {
      // 소속 표기·직위가 바뀐 사람 (조는 그대로)
      var ch = line('소속·직위 바뀜', d.changedCount + '명');
      ch.appendChild(el('span', 'names', ' — ' + names(d.changed.map(function (c) {
        return c.name + ' (' + c.what + ')';
      }), d.changedCount)));
      box.appendChild(ch);
    }
    box.appendChild(line('그대로', d.kept + '명'));
    return box;
  }

  function showDone(d) {
    repCard.innerHTML = '';
    repCard.appendChild(el('h3', null, '참석자 화면에 반영되었습니다'));
    repCard.appendChild(el('p', 'when',
      (d.id ? '버전 ' + d.id : '앱 파일 자료') + (d.prevId ? ' (이전 버전 ' + d.prevId + ')' : '') + ' · '
      + fmtKst(d.at || Date.now())
      + ' · ' + (d.source === 'editor' ? '직접 편집' : d.source === 'file' ? '앱 파일의 자료' : '엑셀 파일')));

    var dl = el('dl');
    var put = function (k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); };
    put('명단', d.people + '명 · ' + d.groups + '개 조');
    put('석식', d.dinner + '명 · ' + d.dinnerGroups + '개 조');
    put('프로그램', (d.title || '(제목 없음)') + (d.dateRange ? ' · ' + d.dateRange : ''));
    put('일정', (d.days || []).length + '일 · ' + d.rows + '개 항목'
      + ((d.days || []).length ? ' (' + d.days.map(function (x) { return (x.label || '') + ' ' + x.rows + '개'; }).join(' / ') + ')' : ''));
    put('강의 목록', d.lineup + '건');
    repCard.appendChild(dl);

    repCard.appendChild(diffSection('명단 변동 (Grand Hall)', d.diff, '조배정'));
    repCard.appendChild(diffSection('명단 변동 (석식)', d.dinnerDiff, '석식 조배정'));

    var btns = el('div', 'btns');
    var b1 = el('button', null, '닫고 새로고침');
    b1.type = 'button';
    b1.addEventListener('click', function () { closeReport(true); });
    var b2 = el('button', 'ghost', '이 내역 더 보기');
    b2.type = 'button';
    b2.addEventListener('click', function () { closeReport(false); });
    btns.appendChild(b2);
    btns.appendChild(b1);
    repCard.appendChild(btns);
    rep.dataset.reload = '1';
    rep.hidden = false;
  }

  function showFail(info) {
    var status = info.status || 0;
    var todo = '파일이나 입력한 내용을 확인한 뒤 다시 시도해 주세요.';
    if (status === 401) todo = '로그인이 풀렸습니다. 새 창에서 다시 로그인한 뒤, 이 화면으로 돌아와 한 번 더 누르면 됩니다. (지금 창을 닫지 마세요 — 고친 내용이 남아 있습니다.)';
    else if (status === 503) todo = '워크샵 데이터베이스가 연결되지 않았습니다. 배포 설정(WSDB)을 확인해야 합니다.';
    else if (status === 500) todo = '서버에서 저장하다 막혔습니다. 잠시 뒤 다시 시도하고, 그래도 안 되면 아래 “자세히” 내용을 그대로 알려 주세요.';
    else if (status === 413) todo = '보낸 자료가 너무 큽니다. 명단을 나눠 올리거나 담당자에게 알려 주세요.';
    else if (!status) todo = '서버에 닿지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요. 고친 내용은 그대로 남아 있습니다.';

    repCard.innerHTML = '';
    repCard.appendChild(el('h3', null, '반영하지 못했습니다'));
    repCard.appendChild(el('p', 'when', fmtKst(Date.now())
      + ' · 참석자 화면은 그대로입니다 (바뀐 것이 없습니다)'));

    var why = el('div', 'why');
    why.appendChild(el('div', 'k', '단계'));
    why.appendChild(el('div', 'v', info.step || '알 수 없음'));
    why.appendChild(el('div', 'k', '원인'));
    why.appendChild(el('div', 'v', info.error || '알 수 없는 오류'));
    if (info.detail) {
      why.appendChild(el('div', 'k', '자세히'));
      why.appendChild(el('div', 'v', info.detail));
    }
    why.appendChild(el('div', 'k', '응답 코드'));
    why.appendChild(el('div', 'v', status ? String(status) : '(응답 없음)'));
    repCard.appendChild(why);
    repCard.appendChild(el('div', 'todo', todo));

    var btns = el('div', 'btns');
    var b = el('button', null, '닫기');
    b.type = 'button';
    b.addEventListener('click', function () { closeReport(false); });
    btns.appendChild(b);
    repCard.appendChild(btns);
    rep.dataset.reload = '0';
    rep.hidden = false;
  }

  // 원본 앱의 '게시하기' 를 잇는 다리(head 에 먼저 실린다)가 불러 쓴다
  window.rbDone = showDone;
  window.rbFail = showFail;

  var openBtn = $('rbEditOpen');
  if (openBtn) {
    openBtn.addEventListener('click', function () {
      if (!draft) loadDraft();
      ui.hidden = false;
      document.body.classList.add('rb-editing');
      redraw();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── 설문 배너 ──────────────────────────────────────
  // 배너를 여러 개 만들어 두고, 각각 표시 시작·끝 시각(한국시간)을 정한다.
  // 자동이면 시간이 되는 대로 저절로 바뀌고, 직접 고르기면 목록에서 고른 하나만 나간다.
  // 고친 값은 워크샵 DB(ws_settings)에 들어가고 배포 없이 참석자 화면에 바로 반영된다.
  var svBtn = $('rbSvEdit');
  if (svBtn) {
    var svUi = null;
    var cfg = null;        // { mode, pinnedId, banners:[] }
    var states = {};       // id → live|soon|done|idle|off
    var blank = null;      // 새 배너의 빈 서식
    var defaults = null;   // '처음 문구로' 값
    var editing = -1;      // 지금 고치는 배너 자리 (-1 이면 목록 화면)
    var svNow = '';

    function svCss() {
      if ($('rbSvStyle')) return;
      var st = document.createElement('style');
      st.id = 'rbSvStyle';
      st.textContent = [
        '.rb-svbox{position:fixed;inset:0;z-index:4000;background:rgba(10,16,22,.55);display:flex;',
        '  align-items:flex-start;justify-content:center;padding:24px 16px;overflow:auto}',
        '.rb-svbox[hidden]{display:none}',
        '.rb-svcard{display:flex;flex-direction:column;width:min(600px,100%);max-height:calc(100vh - 48px);',
        '  background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);font-family:inherit;color:var(--text)}',
        '.rb-svhead{position:relative;padding:20px 52px 0 20px}',
        '.rb-svx{position:absolute;top:14px;right:14px;width:32px;height:32px;display:grid;place-items:center;',
        '  border:1px solid var(--border);border-radius:999px;background:var(--surface-alt);color:var(--text);',
        '  font:600 15px/1 inherit;cursor:pointer;padding:0}',
        '.rb-svx:hover{background:var(--accent-soft);border-color:var(--accent-soft-border);color:var(--accent-strong)}',
        '.rb-svscroll{flex:1;min-height:0;overflow:auto;padding:16px 20px 4px}',
        '.rb-svfoot{padding:12px 20px 18px;border-top:1px solid var(--border);background:var(--surface);border-radius:0 0 var(--radius) var(--radius)}',
        '.rb-svcard h3{margin:0 0 4px;font-size:17px;font-weight:800}',
        '.rb-svcard .d{margin:0 0 4px;font-size:12.5px;color:var(--text-muted);line-height:1.6}',

        /* 자동 / 직접 고르기 */
        '.rb-svmode{display:flex;gap:6px;padding:4px;margin-bottom:14px;background:var(--surface-alt);',
        '  border:1px solid var(--border);border-radius:12px}',
        '.rb-svmode button{flex:1;padding:9px 0;border:0;border-radius:9px;background:transparent;color:var(--text-muted);',
        '  font:600 13px inherit;cursor:pointer}',
        '.rb-svmode button.on{background:var(--surface);color:var(--accent-strong);font-weight:700;box-shadow:var(--shadow)}',
        '.rb-svmode button .sm{font-size:11.5px;font-weight:500;opacity:.75;margin-left:3px}',
        '.rb-svmodenote{margin:-8px 0 14px;font-size:12px;color:var(--text-muted);line-height:1.55}',

        /* 배너 목록 */
        '.rb-svlist{display:flex;flex-direction:column;gap:8px}',
        '.rb-svitem{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:12px 14px}',
        '.rb-svitem.live{border-color:var(--accent-soft-border);background:var(--accent-soft)}',
        '.rb-svitem.off{opacity:.62}',
        '.rb-svtop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.rb-svname{font-size:14px;font-weight:700;flex:1;min-width:120px;word-break:keep-all}',
        '.rb-svtag{flex:none;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;',
        '  background:var(--chip-bg);color:var(--text-muted);border:1px solid var(--border)}',
        '.rb-svtag.live{background:var(--accent);color:#fff;border-color:var(--accent)}',
        '.rb-svtag.soon{background:var(--highlight-bg);color:var(--highlight-text);border-color:var(--highlight-border)}',
        '.rb-svwhen{margin-top:5px;font-size:12px;color:var(--text-muted);line-height:1.5}',
        '.rb-svacts{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
        '.rb-svacts button{padding:6px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);',
        '  color:var(--text);font:600 12px inherit;cursor:pointer}',
        '.rb-svacts button:hover{background:var(--accent-soft);border-color:var(--accent-soft-border);color:var(--accent-strong)}',
        '.rb-svacts button.now{background:var(--accent);border-color:var(--accent);color:#fff}',
        '.rb-svacts button.now:hover{background:var(--accent-strong);border-color:var(--accent-strong);color:#fff}',
        '.rb-svacts button.del:hover{background:#FEF2F2;border-color:#FCA5A5;color:#C81330}',
        '.rb-svacts .sp{flex:1}',
        '.rb-svadd{width:100%;margin-top:10px;padding:11px;border:1px dashed var(--accent-soft-border);border-radius:11px;',
        '  background:var(--accent-soft);color:var(--accent-strong);font:700 13px inherit;cursor:pointer}',
        '.rb-svadd:hover{border-style:solid}',
        '.rb-svempty{padding:22px 4px;text-align:center;font-size:13px;color:var(--text-muted);line-height:1.6}',

        /* 편집 서식 */
        '.rb-svf{margin-bottom:12px}',
        '.rb-svf label{display:block;margin-bottom:5px;font-size:12.5px;font-weight:700;color:var(--text)}',
        '.rb-svf .hint{font-weight:500;color:var(--text-muted);margin-left:6px}',
        '.rb-svf input[type=text],.rb-svf input[type=datetime-local],.rb-svf textarea{width:100%;font-family:inherit;',
        '  font-size:14px;padding:10px 12px;border-radius:10px;border:1.5px solid var(--border);',
        '  background:var(--surface);color:var(--text);outline:none}',
        '.rb-svf input:focus,.rb-svf textarea:focus{border-color:var(--accent)}',
        '.rb-svf textarea{resize:vertical;min-height:62px;line-height:1.5}',
        '.rb-svtwo{display:flex;gap:10px}.rb-svtwo>*{flex:1;min-width:0}',
        '.rb-svon{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:11px 13px;border-radius:10px;',
        '  background:var(--surface-alt);border:1px solid var(--border);font-size:13px;font-weight:700;cursor:pointer}',
        '.rb-svon input{width:17px;height:17px;accent-color:var(--accent);cursor:pointer}',
        '.rb-svprev{margin:6px 0 16px;padding:12px;border-radius:12px;background:var(--surface-alt);border:1px solid var(--border)}',
        '.rb-svprev .cap{font-size:11.5px;font-weight:700;color:var(--text-muted);margin-bottom:8px}',

        '.rb-svrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.rb-svrow button{padding:10px 16px;border-radius:10px;border:1px solid var(--border);background:var(--surface-alt);',
        '  color:var(--text);font:700 13px inherit;cursor:pointer}',
        '.rb-svrow button:hover{background:var(--accent-soft);border-color:var(--accent-soft-border);color:var(--accent-strong)}',
        '.rb-svrow button.primary{background:var(--accent);border-color:var(--accent);color:#fff}',
        '.rb-svrow button.primary:hover{background:var(--accent-strong);border-color:var(--accent-strong);color:#fff}',
        '.rb-svrow .sp{flex:1}',
        '.rb-svmsg{margin-top:10px;font-size:12.5px;line-height:1.5}',
        '.rb-svmsg:empty{display:none}',
        '.rb-svmsg.ok{color:#15803D} .rb-svmsg.err{color:#C81330}',
        '@media (max-width:560px){.rb-svbox{padding:12px 10px}.rb-svcard{max-height:calc(100vh - 24px)}',
        '  .rb-svhead{padding:16px 16px 0}.rb-svscroll{padding:12px 16px 4px}.rb-svfoot{padding:10px 16px 14px}',
        '  .rb-svtwo{flex-direction:column;gap:0}',
        '  .rb-svrow{gap:6px}.rb-svrow button{flex:1 1 auto;padding:10px 8px;font-size:12.5px}',
        '  .rb-svrow .sp{flex:1 0 100%;height:0}}',
      ].join('\n');
      document.head.appendChild(st);
    }

    function esc(v) {
      return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }

    // '2026-09-21T09:00' → '9/21 09:00'
    function whenText(v) {
      if (!v) return '';
      var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
      if (!m) return v;
      return Number(m[2]) + '/' + Number(m[3]) + ' ' + m[4] + ':' + m[5];
    }

    function svBuild() {
      svCss();
      var el = document.createElement('div');
      el.className = 'rb-svbox';
      el.id = 'rbSvBox';
      el.hidden = true;
      el.innerHTML = '<div class="rb-svcard">'
        + '<div class="rb-svhead"><button type="button" class="rb-svx" id="rbSvX" aria-label="닫기">\u2715</button>'
        + '<h3 id="rbSvH">설문 배너</h3><p class="d" id="rbSvD"></p></div>'
        + '<div class="rb-svscroll" id="rbSvBody"></div>'
        + '<div class="rb-svfoot"><div class="rb-svrow" id="rbSvActs"></div>'
        + '<p class="rb-svmsg" id="rbSvMsg"></p></div></div>';
      document.body.appendChild(el);
      el.addEventListener('click', function (e) { if (e.target === el) svClose(); });
      el.querySelector('#rbSvX').addEventListener('click', svClose);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !el.hidden) svClose(); });
      return el;
    }

    function svSay(t, k) {
      var m = $('rbSvMsg');
      if (!m) return;
      m.textContent = t || '';
      m.className = 'rb-svmsg' + (k ? ' ' + k : '');
    }

    function svClose() { if (svUi) svUi.hidden = true; }

    // ── 목록 화면 ──
    function drawList() {
      editing = -1;
      $('rbSvH').textContent = '설문 배너';
      $('rbSvD').innerHTML = '참석자 화면(<b>/workshop/</b>) 맨 위에 뜨는 안내입니다. 여러 개를 만들어 두고'
        + ' 정해 둔 시각에 저절로 바뀌게 하거나, 목록에서 바로 골라 바꿉니다. 저장하면 배포 없이 바로 반영됩니다.';

      var auto = cfg.mode !== 'pin';
      var html = '<div class="rb-svmode">'
        + '<button type="button" data-mode="auto"' + (auto ? ' class="on"' : '') + '>자동 전환<span class="sm">(시간 예약)</span></button>'
        + '<button type="button" data-mode="pin"' + (auto ? '' : ' class="on"') + '>직접 고르기</button></div>'
        + '<p class="rb-svmodenote">' + (auto
          ? '배너마다 정해 둔 <b>표시 기간</b>에 맞춰 저절로 바뀝니다. 기간이 겹치면 늦게 시작한 쪽이 이기고, 기간을 안 정한 배너가 그 사이를 메웁니다.'
          : '표시 기간을 무시하고 <b>고른 배너 하나</b>만 계속 나갑니다.') + '</p>';

      if (!cfg.banners.length) {
        html += '<div class="rb-svempty">아직 만들어 둔 배너가 없습니다.<br>아래에서 하나 추가해 보세요.</div>';
      } else {
        html += '<div class="rb-svlist">' + cfg.banners.map(function (b, i) {
          var st = states[b.id] || 'idle';
          var tag = { live: '지금 표시 중', soon: '예정', done: '끝남', off: '꺼짐', idle: '대기' }[st];
          var when = b.from || b.until
            ? (whenText(b.from) || '처음') + ' ~ ' + (whenText(b.until) || '계속')
            : '표시 기간 없음 — 예약한 배너가 없는 동안 나갑니다';
          return '<div class="rb-svitem ' + st + '">'
            + '<div class="rb-svtop"><span class="rb-svname">' + esc(b.name || b.title) + '</span>'
            + '<span class="rb-svtag ' + st + '">' + tag + '</span></div>'
            + '<div class="rb-svwhen">' + esc(b.title) + '<br>' + esc(when) + '</div>'
            + '<div class="rb-svacts">'
            + (st === 'live' ? '' : '<button type="button" class="now" data-now="' + i + '">지금 이걸로</button>')
            + '<button type="button" data-edit="' + i + '">고치기</button>'
            + '<button type="button" data-copy="' + i + '">복제</button>'
            + '<span class="sp"></span>'
            + '<button type="button" class="del" data-del="' + i + '">삭제</button>'
            + '</div></div>';
        }).join('') + '</div>';
      }
      html += '<button type="button" class="rb-svadd" id="rbSvAdd">+ 배너 추가</button>';
      $('rbSvBody').innerHTML = html;
      $('rbSvActs').innerHTML = '<span class="sp"></span>'
        + '<button type="button" id="rbSvCancel">닫기</button>'
        + '<button type="button" class="primary" id="rbSvSave">저장</button>';

      $('rbSvBody').querySelectorAll('[data-mode]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.dataset.mode === 'pin' && !cfg.pinnedId) {
            var first = cfg.banners.find(function (x) { return x.on !== false; });
            if (!first) { svSay('켜 둔 배너가 없습니다. 먼저 배너를 켜 주세요.', 'err'); return; }
            cfg.pinnedId = first.id;
          }
          cfg.mode = b.dataset.mode;
          recount(); drawList(); svSay('');
        });
      });
      $('rbSvBody').querySelectorAll('[data-now]').forEach(function (b) {
        b.addEventListener('click', function () {
          var t = cfg.banners[Number(b.dataset.now)];
          cfg.mode = 'pin'; cfg.pinnedId = t.id; t.on = true;
          recount(); drawList();
          svSay('‘' + (t.name || t.title) + '’ 을(를) 지금 보여 주도록 했습니다. 저장을 눌러야 반영됩니다.');
        });
      });
      $('rbSvBody').querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () { drawEdit(Number(b.dataset.edit)); });
      });
      $('rbSvBody').querySelectorAll('[data-copy]').forEach(function (b) {
        b.addEventListener('click', function () {
          var src = cfg.banners[Number(b.dataset.copy)];
          var copy = JSON.parse(JSON.stringify(src));
          copy.id = 'b' + Date.now().toString(36);
          copy.name = (src.name || src.title) + ' 복사본';
          cfg.banners.splice(Number(b.dataset.copy) + 1, 0, copy);
          recount(); drawList(); svSay('');
        });
      });
      $('rbSvBody').querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          var t = cfg.banners[Number(b.dataset.del)];
          if (!window.confirm('‘' + (t.name || t.title) + '’ 배너를 지울까요?')) return;
          cfg.banners.splice(Number(b.dataset.del), 1);
          if (cfg.pinnedId === t.id) { cfg.pinnedId = ''; cfg.mode = 'auto'; }
          recount(); drawList(); svSay('');
        });
      });
      $('rbSvAdd').addEventListener('click', function () {
        var b = JSON.parse(JSON.stringify(blank));
        b.id = 'b' + Date.now().toString(36);
        b.name = '새 배너';
        cfg.banners.push(b);
        drawEdit(cfg.banners.length - 1);
      });
      $('rbSvCancel').addEventListener('click', svClose);
      $('rbSvSave').addEventListener('click', svSave);
    }

    // 저장 전에도 목록의 '지금 표시 중' 이 맞게 보이도록 브라우저에서 한 번 더 셈한다
    function recount() {
      var now = svNow;
      var on = cfg.banners.filter(function (b) { return b.on !== false; });
      var pick = null;
      if (cfg.mode === 'pin') {
        pick = on.find(function (b) { return b.id === cfg.pinnedId; }) || null;
      } else {
        var live = on.filter(function (b) {
          return (!b.from || b.from <= now) && (!b.until || now <= b.until);
        });
        live.sort(function (a, b) { return (b.from || '').localeCompare(a.from || ''); });
        pick = live[0] || null;
      }
      states = {};
      cfg.banners.forEach(function (b) {
        if (b.on === false) { states[b.id] = 'off'; return; }
        if (cfg.mode === 'pin') { states[b.id] = b.id === cfg.pinnedId ? 'live' : 'idle'; return; }
        if (b.until && now > b.until) { states[b.id] = 'done'; return; }
        if (b.from && now < b.from) { states[b.id] = 'soon'; return; }
        states[b.id] = pick && pick.id === b.id ? 'live' : 'idle';
      });
    }

    // ── 편집 화면 ──
    function drawEdit(i) {
      editing = i;
      var b = cfg.banners[i];
      $('rbSvH').textContent = '배너 고치기';
      $('rbSvD').textContent = '고친 내용은 ‘목록으로’ 를 눌러 담아 두고, 마지막에 저장을 누르면 한꺼번에 반영됩니다.';
      $('rbSvBody').innerHTML = ''
        + '<label class="rb-svon"><input type="checkbox" id="rbSvOn"><span>이 배너 바로 사용</span></label>'
        + '<div class="rb-svf"><label for="rbSvName">배너 이름<span class="hint">목록에서만 보입니다</span></label>'
        + '<input type="text" id="rbSvName" autocomplete="off"></div>'
        + '<div class="rb-svtwo">'
        + '<div class="rb-svf"><label for="rbSvFrom">표시 시작<span class="hint">비우면 처음부터</span></label>'
        + '<input type="datetime-local" id="rbSvFrom"></div>'
        + '<div class="rb-svf"><label for="rbSvUntil">표시 끝<span class="hint">비우면 계속</span></label>'
        + '<input type="datetime-local" id="rbSvUntil"></div></div>'
        + '<div class="rb-svf"><label for="rbSvUrl">링크 주소<span class="hint">복사한 주소를 그대로 붙여 넣으세요</span></label>'
        + '<input type="text" id="rbSvUrl" placeholder="https://..." autocomplete="off" spellcheck="false"></div>'
        + '<div class="rb-svf"><label for="rbSvEyebrow">작은 윗줄<span class="hint">배너 맨 위 작은 글씨</span></label>'
        + '<input type="text" id="rbSvEyebrow" autocomplete="off"></div>'
        + '<div class="rb-svf"><label for="rbSvTitle">제목</label>'
        + '<input type="text" id="rbSvTitle" autocomplete="off"></div>'
        + '<div class="rb-svf"><label for="rbSvShort">접었을 때 제목<span class="hint">한 줄로 줄었을 때</span></label>'
        + '<input type="text" id="rbSvShort" autocomplete="off"></div>'
        + '<div class="rb-svf"><label for="rbSvSub">안내 문구</label><textarea id="rbSvSub"></textarea></div>'
        + '<div class="rb-svf"><label for="rbSvCta">단추 글자</label>'
        + '<input type="text" id="rbSvCta" autocomplete="off"></div>'
        + '<div class="rb-svprev"><div class="cap">미리보기</div><div id="rbSvPrev"></div></div>';
      $('rbSvActs').innerHTML = '<button type="button" id="rbSvReset">기본 문구 채우기</button>'
        + '<button type="button" id="rbSvDrop">이 배너 지우기</button><span class="sp"></span>'
        + '<button type="button" id="rbSvShut">닫기</button>'
        + '<button type="button" class="primary" id="rbSvBack">목록으로</button>';

      $('rbSvOn').checked = b.on !== false;
      ['Name', 'From', 'Until', 'Url', 'Eyebrow', 'Title', 'Short', 'Sub', 'Cta'].forEach(function (k) {
        $('rbSv' + k).value = b[k.toLowerCase()] || '';
      });
      ['rbSvOn', 'rbSvName', 'rbSvFrom', 'rbSvUntil', 'rbSvUrl', 'rbSvEyebrow', 'rbSvTitle', 'rbSvShort', 'rbSvSub', 'rbSvCta']
        .forEach(function (id) {
          var f = $(id);
          f.addEventListener('input', pullEdit);
          f.addEventListener('change', pullEdit);
        });
      $('rbSvReset').addEventListener('click', function () {
        var keep = { id: b.id, name: b.name, from: b.from, until: b.until, on: b.on };
        cfg.banners[editing] = Object.assign({}, defaults, keep);
        drawEdit(editing);
      });
      $('rbSvShut').addEventListener('click', svClose);
      $('rbSvDrop').addEventListener('click', function () {
        var cur = cfg.banners[editing];
        if (cur.title && !window.confirm('‘' + (cur.name || cur.title) + '’ 배너를 지울까요?')) return;
        cfg.banners.splice(editing, 1);
        if (cfg.pinnedId === cur.id) { cfg.pinnedId = ''; cfg.mode = 'auto'; }
        recount(); drawList(); svSay('');
      });
      $('rbSvBack').addEventListener('click', function () {
        pullEdit();
        var cur = cfg.banners[editing];
        if (!cur.url || !cur.title) {
          svSay('링크 주소와 제목을 채워 주세요. 이 배너가 필요 없으면 ‘이 배너 지우기’ 를 누르세요.', 'err');
          return;
        }
        recount(); drawList(); svSay('');
      });
      pullEdit();
    }

    // 편집 화면의 값을 cfg 로 옮기고 미리보기를 다시 그린다
    function pullEdit() {
      if (editing < 0) return;
      var b = cfg.banners[editing];
      b.on = $('rbSvOn').checked;
      ['name', 'from', 'until', 'url', 'eyebrow', 'title', 'short', 'sub', 'cta'].forEach(function (k) {
        b[k] = $('rbSv' + k.charAt(0).toUpperCase() + k.slice(1)).value.trim();
      });
      drawPreview(b);
    }

    // 참석자가 볼 모습 그대로 — 실제 배너와 같은 클래스를 써서 그린다
    function drawPreview(v) {
      var box = $('rbSvPrev');
      if (!box) return;
      if (v.on === false) {
        box.innerHTML = '<p style="margin:0;font-size:12.5px;color:var(--text-muted)">이 배너는 쓰지 않습니다.</p>';
        return;
      }
      box.innerHTML = '<div class="rb-sv" style="margin:0">'
        + '<div class="rb-sv-head">'
        + '<span class="rb-sv-ico">📋</span>'
        + '<span class="rb-sv-t"><span class="e">' + esc(v.eyebrow) + '</span>'
        + '<span class="h">' + esc(v.title) + '</span></span>'
        + '<span class="rb-sv-tg" style="display:grid">'
        + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
        + ' stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg></span></div>'
        + '<div class="rb-sv-body"><div><div class="rb-sv-in"><p>' + esc(v.sub) + '</p>'
        + '<span class="rb-sv-btn">' + esc(v.cta)
        + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"'
        + ' stroke-linejoin="round"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"/></svg></span>'
        + '</div></div></div></div>';
    }

    async function svSave() {
      var btn = $('rbSvSave');
      btn.disabled = true;
      svSay('저장하는 중…');
      try {
        var r = await fetch('/api/workshop/survey', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || '저장하지 못했습니다.');
        svSay(d.activeId
          ? '저장했습니다. 지금은 ‘' + (d.activeName || '') + '’ 이(가) 참석자 화면에 나갑니다. 잠시 후 새로고침됩니다.'
          : '저장했습니다. 지금 시각에 내보낼 배너가 없어 참석자 화면에는 아무것도 뜨지 않습니다. 잠시 후 새로고침됩니다.', 'ok');
        setTimeout(function () { location.reload(); }, 1600);
      } catch (e) {
        svSay(e.message, 'err');
        btn.disabled = false;
      }
    }

    svBtn.addEventListener('click', async function () {
      if (!svUi) svUi = svBuild();
      if (!svUi.hidden) { svClose(); return; }
      svUi.hidden = false;
      svSay('');
      try {
        var r = await fetch('/api/workshop/survey');
        var d = await r.json();
        cfg = d.config; states = d.states || {}; blank = d.blank; defaults = d.defaults; svNow = d.now;
        drawList();
      } catch (e) { svSay(e.message, 'err'); }
    });
  }
})();
