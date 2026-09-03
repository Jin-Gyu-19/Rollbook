// 워크샵 관리 화면 전용 스크립트 — /workshop/admin 에서만 불린다.
// (관리자만 볼 수 있는 주소라서 이 파일 자체도 로그인 없이는 받아지지 않는다.)
// 다른 사람이 만든 public/workshop/index.html 은 손대지 않고, 이 파일이
// 그 위에 관리자 줄과 편집기를 얹는다. 편집기가 고치는 것은 화면에 이미
// 올라와 있는 자료(PEOPLE · PROGRAM · DINNER)의 사본이고, 저장하면 새 버전으로
// 데이터베이스에 쌓여 참석자 화면에 그대로 반영된다.
(function () {
  'use strict';

  // 원본 앱의 색·글꼴 변수(--surface, --accent, --radius …)를 그대로 써서 한 앱처럼 보이게 한다.
  // 다크 모드도 원본 변수를 따라 저절로 맞춰진다.
  var CSS = [
    '.rbed, .rbrep { font-family: "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Malgun Gothic", sans-serif;',
    '  color: var(--text); -webkit-font-smoothing: antialiased; }',
    '.rbed button, .rbed input, .rbed textarea, .rbrep button { font-family: inherit; }',

    /* ── 편집기 전체 ── */
    '.rbed { position: fixed; inset: 0; z-index: 3000; background: var(--bg); display: flex; flex-direction: column; font-size: 13.5px; line-height: 1.5; }',
    '.rbed[hidden] { display: none; }',
    '.rbed-head { display: flex; align-items: center; gap: 12px; padding: 12px 18px; background: var(--surface);',
    '  border-bottom: 1px solid var(--border); box-shadow: var(--shadow); position: relative; z-index: 1; flex-wrap: wrap; }',
    '.rbed-head b { font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }',
    '.rbed-tabs { display: flex; gap: 4px; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 12px; padding: 4px; }',
    '.rbed-tabs button { border: 0; background: transparent; color: var(--text-muted); font-size: 13.5px; font-weight: 600;',
    '  padding: 7px 14px; border-radius: 9px; cursor: pointer; transition: background .15s ease, color .15s ease; }',
    '.rbed-tabs button.on { background: var(--surface); color: var(--accent-strong); box-shadow: var(--shadow); }',
    '.rbed-sp { flex: 1; }',
    '.rbed-msg { font-size: 12.5px; color: var(--text-muted); }',
    '.rbed-msg.err { color: #C81330; }',
    '.rbed-msg.ok { color: #15803D; }',
    '.rbed-head .go, .rbed-head .close { font-size: 13px; font-weight: 700; padding: 9px 16px; border-radius: 10px; cursor: pointer;',
    '  border: 1px solid var(--border); background: var(--surface-alt); color: var(--text); }',
    '.rbed-head .go { background: var(--accent); color: #fff; border-color: var(--accent); }',
    '.rbed-head .go:disabled { opacity: .5; cursor: not-allowed; }',
    '.rbed-head button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
    '.rbed-body { flex: 1; overflow: auto; padding: 20px 18px 72px; }',
    '.rbed-body > * { max-width: 1040px; margin-left: auto; margin-right: auto; }',
    '.rbed-body h3 { margin: 0 0 3px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }',
    '.rbed-body .hint { margin: 0 0 14px; color: var(--text-muted); font-size: 12.5px; line-height: 1.6; }',

    /* ── 카드 ── */
    '.rbed-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);',
    '  padding: 16px; margin-bottom: 14px; }',
    '.rbed-card > h4 { margin: 0 0 12px; font-size: 14px; font-weight: 800; display: flex; align-items: center; gap: 10px; }',
    '.rbed-card > h4 .n { color: var(--text-muted); font-weight: 500; font-size: 12.5px; }',

    /* ── 입력칸 ── */
    '.rbed input[type=text], .rbed input[type=number], .rbed textarea {',
    '  width: 100%; padding: 8px 10px; border: 1.5px solid var(--border); border-radius: 10px; background: var(--surface);',
    '  color: var(--text); font-size: 13px; line-height: 1.45; outline: none; transition: border-color .15s ease; }',
    '.rbed textarea { resize: vertical; min-height: 38px; }',
    '.rbed input:focus, .rbed textarea:focus { border-color: var(--accent); }',
    '.rbed input:focus-visible, .rbed textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
    '.rbed-f { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 8px; margin-bottom: 8px; }',
    '.rbed-f label { color: var(--text-muted); font-size: 12.5px; font-weight: 700; }',

    /* ── 표 ── */
    '.rbed table { width: 100%; border-collapse: collapse; }',
    '.rbed th { text-align: left; font-size: 12px; color: var(--text-muted); font-weight: 700; padding: 0 6px 8px; }',
    '.rbed td { padding: 3px 6px 3px 0; vertical-align: top; }',
    '.rbed td.mini { width: 34px; padding-right: 0; }',
    '.rbed .rowbtn { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-alt);',
    '  color: var(--text-muted); font-size: 13px; font-weight: 700; cursor: pointer; }',
    '.rbed .rowbtn:hover { background: var(--accent-soft); border-color: var(--accent-soft-border); color: var(--accent-strong); }',
    '.rbed .rowbtn.del:hover { background: #FEF2F2; border-color: #FCA5A5; color: #C81330; }',
    '.rbed .add { margin-top: 10px; padding: 8px 14px; border: 1px dashed var(--accent-soft-border); border-radius: 10px;',
    '  background: var(--accent-soft); color: var(--accent-strong); font-size: 12.5px; font-weight: 700; cursor: pointer; }',
    '.rbed .add:hover { border-style: solid; }',
    '.rbed .tool { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }',
    '.rbed .tool input[type=text] { width: 240px; }',
    '.rbed .tool .add { margin-top: 0; }',
    '.rbed .tool .cnt { color: var(--text-muted); font-size: 12.5px; margin-left: 4px; }',
    '.rbed .ai { width: 16px; height: 16px; accent-color: var(--accent); }',
    '.rbed .warn { color: #C81330; font-size: 12.5px; margin-top: 6px; }',

    /* ── 적용 내역 · 실패 원인 ── */
    '.rbrep { position: fixed; inset: 0; z-index: 4000; background: rgba(18,48,73,.45); display: flex;',
    '  align-items: center; justify-content: center; padding: 24px; font-size: 13.5px; line-height: 1.6; }',
    '.rbrep[hidden] { display: none; }',
    '.rbrep .card { width: min(720px, 100%); max-height: 88vh; overflow: auto; background: var(--surface); color: var(--text);',
    '  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 22px 24px 18px; }',
    '.rbrep h3 { margin: 0 0 2px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }',
    '.rbrep .when { color: var(--text-muted); font-size: 12.5px; margin: 0 0 16px; }',
    '.rbrep dl { display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; margin: 0 0 14px; }',
    '.rbrep dt { color: var(--text-muted); font-size: 12.5px; font-weight: 700; }',
    '.rbrep dd { margin: 0; }',
    '.rbrep .sec { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }',
    '.rbrep .sec > b { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 800; }',
    '.rbrep .line { display: flex; gap: 8px; margin-bottom: 5px; align-items: baseline; }',
    '.rbrep .line .k { flex: none; width: 92px; color: var(--text-muted); font-size: 12.5px; font-weight: 700; }',
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
        vers.innerHTML = '<p>아직 올린 버전이 없습니다. 지금은 파일에 들어 있던 원래 명단을 쓰고 있습니다.</p>';
        return;
      }
      vers.innerHTML = '<table>' + d.versions.map(function (v) {
        return '<tr><td>' + (v.is_active ? '● 사용 중' : '') + '</td><td>버전 ' + v.id + '</td>'
          + '<td>' + v.created_at.slice(0, 16).replace('T', ' ') + '</td>'
          + '<td>' + v.people_count + '명 · ' + v.group_count + '조</td><td>'
          + (v.is_active ? '' : '<button type="button" data-id="' + v.id + '">이 버전으로</button>') + '</td></tr>';
      }).join('') + '</table>';
      vers.querySelectorAll('button[data-id]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          var r2 = await fetch('/api/workshop/activate', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: Number(btn.dataset.id) }),
          });
          var d2 = await r2.json();
          if (r2.ok) {
            say('버전 ' + btn.dataset.id + ' 로 되돌렸습니다. 잠시 후 새로고침됩니다.', 'ok');
            setTimeout(function () { location.reload(); }, 1200);
          } else { say(d2.error || '되돌리지 못했습니다.', 'err'); btn.disabled = false; }
        });
      });
    } catch (e) { say(e.message, 'err'); }
  });

  // ── 직접 편집 ────────────────────────────────────────
  var draft = null;      // { PROGRAM, PEOPLE, DINNER }
  var labels = { PEOPLE: {}, DINNER: {} }; // 조 번호 → 조 이름
  var dirty = false;
  var tab = 'program';

  var ui = el('div', 'rbed');
  ui.hidden = true;
  ui.innerHTML =
    '<div class="rbed-head"><b>직접 편집</b>'
    + '<div class="rbed-tabs">'
    + '<button type="button" data-t="program">프로그램</button>'
    + '<button type="button" data-t="people">조배정</button>'
    + '<button type="button" data-t="dinner">석식</button></div>'
    + '<span class="rbed-sp"></span><span class="rbed-msg"></span>'
    + '<button type="button" class="go">저장하고 참석자 화면에 반영</button>'
    + '<button type="button" class="close">닫기</button></div>'
    + '<div class="rbed-body"></div>';
  document.body.appendChild(ui);

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
  function field(obj, key, kind, opts) {
    opts = opts || {};
    var n = document.createElement(opts.multiline ? 'textarea' : 'input');
    if (!opts.multiline) n.type = kind || 'text';
    if (opts.rows) n.rows = opts.rows;
    if (opts.min != null) n.min = opts.min;
    if (opts.placeholder) n.placeholder = opts.placeholder;
    n.value = obj[key] == null ? '' : String(obj[key]);
    n.addEventListener('input', function () {
      obj[key] = kind === 'number' ? (n.value === '' ? '' : Number(n.value)) : n.value;
      touch();
    });
    return n;
  }
  function checkbox(obj, key) {
    var n = el('input', 'ai');
    n.type = 'checkbox';
    n.checked = !!obj[key];
    n.addEventListener('change', function () { obj[key] = n.checked; touch(); });
    return n;
  }
  function iconBtn(txt, cls, fn) {
    var b = el('button', 'rowbtn' + (cls ? ' ' + cls : ''), txt);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function addBtn(txt, fn) {
    var b = el('button', 'add', txt);
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
  function cell(row, node, cls) {
    var td = el('td', cls || null);
    td.appendChild(node);
    row.appendChild(td);
    return td;
  }

  // ── 프로그램 탭 ─────────────────────────────────────
  function renderProgram() {
    var P = draft.PROGRAM;
    body.appendChild(el('h3', null, '프로그램'));
    body.appendChild(el('p', 'hint', '참석자 화면의 Program 탭에 그대로 나갑니다. 내용·비고 칸은 줄바꿈을 그대로 살립니다.'));

    var head = el('div', 'rbed-card');
    [['제목', 'title'], ['기간', 'dateRange']].forEach(function (f) {
      var w = el('div', 'rbed-f');
      w.appendChild(el('label', null, f[0]));
      w.appendChild(field(P, f[1]));
      head.appendChild(w);
    });
    body.appendChild(head);

    P.days.forEach(function (day, di) {
      var card = el('div', 'rbed-card');
      var h = el('h4');
      var lab = field(day, 'label');
      lab.style.maxWidth = '260px';
      h.appendChild(lab);
      h.appendChild(el('span', 'n', (day.rows || []).length + '개 항목'));
      var sp = el('span'); sp.style.flex = '1'; h.appendChild(sp);
      h.appendChild(iconBtn('✕', 'del', function () {
        if (!confirm('이 일자를 통째로 지울까요?')) return;
        P.days.splice(di, 1); touch(); redraw();
      }));
      card.appendChild(h);

      if (!Array.isArray(day.rows)) day.rows = [];
      var tb = el('table');
      var thead = el('tr');
      ['시간', '내용', '비고', '', '', ''].forEach(function (t) { thead.appendChild(el('th', null, t)); });
      tb.appendChild(thead);
      day.rows.forEach(function (row, ri) {
        var tr = el('tr');
        var time = field(row, 'time');
        time.style.width = '110px';
        cell(tr, time).style.width = '120px';
        cell(tr, field(row, 'content', null, { multiline: true, rows: 2 }));
        cell(tr, field(row, 'note', null, { multiline: true, rows: 2 })).style.width = '30%';
        cell(tr, iconBtn('↑', '', function () { if (move(day.rows, ri, -1)) { touch(); redraw(); } }), 'mini');
        cell(tr, iconBtn('↓', '', function () { if (move(day.rows, ri, 1)) { touch(); redraw(); } }), 'mini');
        cell(tr, iconBtn('✕', 'del', function () { day.rows.splice(ri, 1); touch(); redraw(); }), 'mini');
        tb.appendChild(tr);
      });
      card.appendChild(tb);
      card.appendChild(addBtn('+ 항목 추가', function () {
        day.rows.push({ time: '', content: '', note: '' }); touch(); redraw();
      }));
      body.appendChild(card);
    });
    body.appendChild(addBtn('+ 일자 추가', function () {
      draft.PROGRAM.days.push({ label: 'Day ' + (draft.PROGRAM.days.length + 1), rows: [] });
      touch(); redraw();
    }));

    var lineHead = el('h3', null, '강의 목록');
    lineHead.style.marginTop = '26px';
    body.appendChild(lineHead);
    body.appendChild(el('p', 'hint', 'Program 탭 아래쪽 발표 목록입니다.'));
    P.lineup.forEach(function (g, gi) {
      var card = el('div', 'rbed-card');
      var h = el('h4');
      var c = field(g, 'category');
      c.style.maxWidth = '260px';
      h.appendChild(c);
      var sp = el('span'); sp.style.flex = '1'; h.appendChild(sp);
      h.appendChild(iconBtn('✕', 'del', function () {
        if (!confirm('이 분류를 지울까요?')) return;
        P.lineup.splice(gi, 1); touch(); redraw();
      }));
      card.appendChild(h);
      if (!Array.isArray(g.items)) g.items = [];
      var tb = el('table');
      var thead = el('tr');
      ['본부/부서', '발표자', '주제', '시간', '', '', ''].forEach(function (t) { thead.appendChild(el('th', null, t)); });
      tb.appendChild(thead);
      g.items.forEach(function (it, ii) {
        var tr = el('tr');
        cell(tr, field(it, 'dept')).style.width = '140px';
        cell(tr, field(it, 'speaker')).style.width = '110px';
        cell(tr, field(it, 'topic'));
        cell(tr, field(it, 'duration')).style.width = '90px';
        cell(tr, iconBtn('↑', '', function () { if (move(g.items, ii, -1)) { touch(); redraw(); } }), 'mini');
        cell(tr, iconBtn('↓', '', function () { if (move(g.items, ii, 1)) { touch(); redraw(); } }), 'mini');
        cell(tr, iconBtn('✕', 'del', function () { g.items.splice(ii, 1); touch(); redraw(); }), 'mini');
        tb.appendChild(tr);
      });
      card.appendChild(tb);
      card.appendChild(addBtn('+ 발표 추가', function () {
        g.items.push({ dept: '', speaker: '', topic: '', duration: '' }); touch(); redraw();
      }));
      body.appendChild(card);
    });
    body.appendChild(addBtn('+ 분류 추가', function () {
      draft.PROGRAM.lineup.push({ category: '새 분류', items: [] }); touch(); redraw();
    }));
  }

  // ── 조배정 / 석식 탭 ─────────────────────────────────
  var filterText = { PEOPLE: '', DINNER: '' };

  function renderRoster(kind) {
    var list = draft[kind];
    var isDinner = kind === 'DINNER';
    body.appendChild(el('h3', null, isDinner ? '석식(BBQ) 조배정' : 'Grand Hall 조배정'));
    body.appendChild(el('p', 'hint',
      '조 번호를 고치면 그 사람이 그 조로 옮겨집니다. 이름을 비우면 저장할 때 그 줄은 사라집니다. ★ 는 AI 활용 유경험자 표시입니다.'));

    var tool = el('div', 'tool');
    var q = el('input');
    q.type = 'text';
    q.placeholder = '이름·직급·본부로 좁혀 보기';
    q.value = filterText[kind];
    q.addEventListener('input', function () { filterText[kind] = q.value; redraw(true); });
    tool.appendChild(q);
    tool.appendChild(addBtn('조 순으로 정렬', function () {
      list.sort(function (a, b) {
        return (Number(a.group) || 0) - (Number(b.group) || 0) || String(a.name).localeCompare(String(b.name), 'ko');
      });
      touch(); redraw();
    }));
    tool.appendChild(addBtn('+ 인원 추가', function () {
      list.push({ name: '', pos: '', gender: '', hub: '', dept: '', ai: false, group: 1 });
      filterText[kind] = '';
      touch(); redraw();
    }));
    var groups = {};
    list.forEach(function (p) { groups[Number(p.group) || 0] = true; });
    tool.appendChild(el('span', 'cnt', list.length + '명 · ' + Object.keys(groups).length + '개 조'));
    body.appendChild(tool);

    var needle = filterText[kind].trim();
    var card = el('div', 'rbed-card');
    var tb = el('table');
    var thead = el('tr');
    ['조', '이름', '직급', '본부', '부서', '★', ''].forEach(function (t) { thead.appendChild(el('th', null, t)); });
    tb.appendChild(thead);
    var shown = 0;
    list.forEach(function (p, i) {
      if (needle) {
        var hay = [p.name, p.pos, p.hub, p.dept].join(' ');
        if (hay.indexOf(needle) === -1) return;
      }
      shown++;
      var tr = el('tr');
      var g = field(p, 'group', 'number', { min: 1 });
      g.style.width = '58px';
      cell(tr, g).style.width = '64px';
      cell(tr, field(p, 'name')).style.width = '120px';
      cell(tr, field(p, 'pos')).style.width = '100px';
      cell(tr, field(p, 'hub')).style.width = '150px';
      cell(tr, field(p, 'dept'));
      cell(tr, checkbox(p, 'ai'), 'mini');
      cell(tr, iconBtn('✕', 'del', function () { list.splice(i, 1); touch(); redraw(); }), 'mini');
      tb.appendChild(tr);
    });
    card.appendChild(tb);
    if (needle) card.appendChild(el('p', 'hint', shown + '명만 보이는 중 — 검색칸을 비우면 전체가 나옵니다.'));
    body.appendChild(card);

    // 조 이름 (비워 두면 '1조', '2조' 처럼 번호로 나갑니다)
    var nums = Object.keys(groups).map(Number).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
    var lc = el('div', 'rbed-card');
    var h4 = el('h4', null, '조 이름 (선택)');
    lc.appendChild(h4);
    lc.appendChild(el('p', 'hint', '비워 두면 참석자 화면에 “1조 · 2조 …” 로 나갑니다.'));
    nums.forEach(function (n) {
      var w = el('div', 'rbed-f');
      w.appendChild(el('label', null, n + '조'));
      var input = el('input');
      input.type = 'text';
      input.placeholder = n + '조';
      input.value = labels[kind][n] || '';
      input.addEventListener('input', function () { labels[kind][n] = input.value; touch(); });
      w.appendChild(input);
      lc.appendChild(w);
    });
    body.appendChild(lc);
  }

  var keepScroll = 0;
  function redraw(keep) {
    if (keep) keepScroll = body.scrollTop;
    body.innerHTML = '';
    if (tab === 'program') renderProgram();
    else if (tab === 'people') renderRoster('PEOPLE');
    else renderRoster('DINNER');
    ui.querySelectorAll('.rbed-tabs button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.t === tab);
    });
    if (keep) body.scrollTop = keepScroll;
  }

  ui.querySelectorAll('.rbed-tabs button').forEach(function (b) {
    b.addEventListener('click', function () { tab = b.dataset.t; redraw(); });
  });
  ui.querySelector('.close').addEventListener('click', function () {
    if (dirty && !confirm('저장하지 않은 수정이 있습니다. 그냥 닫을까요?')) return;
    ui.hidden = true;
    document.body.style.overflow = '';
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
        buildDate: new Date().toISOString().slice(0, 10),
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
    if (!d.addedCount && !d.removedCount && !d.movedCount) {
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
    box.appendChild(line('그대로', d.kept + '명'));
    return box;
  }

  function showDone(d) {
    repCard.innerHTML = '';
    repCard.appendChild(el('h3', null, '참석자 화면에 반영되었습니다'));
    repCard.appendChild(el('p', 'when',
      '버전 ' + d.id + (d.prevId ? ' (이전 버전 ' + d.prevId + ')' : '') + ' · '
      + new Date(d.at || Date.now()).toLocaleString('ko-KR')
      + ' · ' + (d.source === 'editor' ? '직접 편집' : '엑셀 파일')));

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
    repCard.appendChild(el('p', 'when', new Date().toLocaleString('ko-KR')
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
      document.body.style.overflow = 'hidden';
      redraw();
    });
  }
})();
