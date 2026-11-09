// 앱 화면 파일을 캐시해 오프라인에서도 열리게 함. 파일을 고치면 VERSION을 올리세요.
const VERSION = 'v13';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'cloud.js', 'config.js', 'manifest.json', 'icon.svg', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // network first, cache fallback
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
