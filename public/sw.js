/* Rollbook 서비스 워커 — 스캔 화면을 인터넷 없이도 띄우기 위한 것.
 *
 * 행사장 인터넷이 끊겨도 스캔 PC 가 화면을 열 수 있어야 해서, 화면을 그리는 데
 * 필요한 파일(HTML·CSS·스크립트·QR 디코더)을 이 PC 안에 담아 둔다.
 * 출석 기록 자체는 여기서 다루지 않는다 — scanner.js 가 브라우저 저장소에
 * 쌓아 두었다가 연결이 돌아오면 서버로 올린다.
 *
 * 주의할 점
 * - /api/ 로 가는 것은 담아 두지 않는다 (옛 답이 되살아나면 안 된다). 로고만 예외.
 * - 200 OK 인 답만 담는다. 로그인이 풀려 302 가 오면 담지 않는다.
 * - 화면(HTML)은 담아 둔 답을 그대로 돌려주지 않고 **새 답으로 다시 만들어** 돌려준다.
 *   '넘겨진(redirected) 답' 을 그대로 주면 브라우저가 화면 열기를 거부한다.
 *   (/index.html 은 서버가 / 로 넘기므로 실제로 그렇게 된다 — 겪어 본 문제다.)
 * - 손대는 파일은 아래 목록뿐. 관리 화면은 건드리지 않는다.
 * - CACHE 이름을 바꾸면 예전에 담아 둔 것은 버려진다.
 */
const CACHE = 'rollbook-scan-2026-09-30';
const SHELL_KEY = '/__scan-shell';   // 스캔 화면 HTML 을 담아 두는 자리

// 화면이 뜨는 데 꼭 필요한 파일들
const ASSETS = [
  '/app.css',
  '/bdo-design.css',
  '/scanner.js',
  '/vendor/zxing-reader.js',
  '/vendor/zxing_reader.wasm',
  '/vendor/jsqr.js',
];
// 있으면 좋지만 없어도 화면은 뜨는 것 (로고는 관리자가 지웠을 수도 있다)
const EXTRA = ['/api/logo'];

// 스캔 화면 HTML 을 받아서 담아 둔다. '/' 로 받아야 넘김이 안 생긴다.
async function cacheShell(cache) {
  const res = await fetch('/', { cache: 'reload', credentials: 'same-origin' });
  if (!res.ok || res.status !== 200 || res.redirected) return false;
  const body = await res.text();
  if (!/id="video"/.test(body)) return false;      // 로그인 화면 등 엉뚱한 것은 담지 않는다
  await cache.put(SHELL_KEY, new Response(body, {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  return true;
}

// 담아 둔 화면을 '갓 만든 답' 으로 돌려준다
async function shellResponse() {
  const hit = await caches.match(SHELL_KEY);
  if (!hit) return null;
  const body = await hit.text();
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나가 실패해도 설치가 통째로 엎어지지 않도록 한 장씩 담는다
    await Promise.all([...ASSETS, ...EXTRA].map(
      (u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}),
    ));
    await cacheShell(cache).catch(() => {});
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 담아 둘 만한 답인가 (200 OK 이고, 넘김이 아닌 것)
function keepable(res) {
  return res && res.ok && res.status === 200 && res.type !== 'opaqueredirect' && !res.redirected;
}

// 이 워커가 손대는 것은 '스캔 화면과 그 부속' 뿐이다.
const SCOPE = new Set([...ASSETS, ...EXTRA]);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 스캔 화면 열기 — 평소엔 서버에서 받아 새것을 쓰고, 끊겼으면 담아 둔 것으로 연다
  if (req.mode === 'navigate') {
    const scanPage = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/scan';
    if (!scanPage) return;                       // 관리 화면 등은 건드리지 않는다
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (keepable(fresh)) {
          const copy = fresh.clone();
          e.waitUntil((async () => {
            const body = await copy.text();
            if (!/id="video"/.test(body)) return;
            const cache = await caches.open(CACHE);
            await cache.put(SHELL_KEY, new Response(body, {
              status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
            }));
          })().catch(() => {}));
        }
        return fresh;                            // 302(로그인 필요)도 그대로 넘겨 준다
      } catch {
        const hit = await shellResponse();
        return hit || new Response(
          '<!doctype html><meta charset="utf-8"><title>오프라인</title>'
          + '<body style="font-family:system-ui,sans-serif;padding:40px;line-height:1.7">'
          + '<h2>오프라인</h2><p>인터넷이 연결된 상태에서 이 화면을 한 번 열어 두어야'
          + ' 끊긴 뒤에도 출석을 받을 수 있습니다.</p>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
    })());
    return;
  }

  // 스캔 화면 부속 파일 — 늘 서버에서 새것을 받고(배포 반영), 못 받으면 담아 둔 것으로.
  if (!SCOPE.has(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (keepable(res)) {
        const cache = await caches.open(CACHE);
        e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      }
      return res;
    } catch {
      const hit = await caches.match(req);
      return hit || new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
