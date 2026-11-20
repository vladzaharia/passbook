/**
 * The scanner's app-shell worker (PS-12), so a paired device that reloads or cold-starts with no
 * connection still opens to the door screen. It keeps only the shell: /scan, its hashed /assets files
 * and the manifest, in a cache named for the build. It never sees /api, never caches a non-GET or a
 * non-200, and keeps nothing a holder could be read from (the roster and queue live in the app's own
 * IndexedDB, cleared on unpair, which also drops this worker and its cache).
 * - network first for the document (3 s), cache on failure; cache first for hashed files;
 * - no skipWaiting: a new build waits until the next load after the old page closes, never mid-shift;
 * - an old build's cache is deleted when the new worker activates.
 */
export const SCAN_SW_PATH = '/scan/sw.js';
export const SCAN_SW_SCOPE = '/scan';
export const SCAN_SHELL_CACHE = 'scan-shell:';

export const scanSwSource = (
  build: string,
): string => `const CACHE = ${JSON.stringify(SCAN_SHELL_CACHE + build)};
const DOC = '/scan';
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch(DOC, { cache: 'reload' });
    if (!res.ok || res.redirected) return;
    await cache.put(DOC, res.clone());
    const files = new Set(['/scan.webmanifest']);
    for (const m of (await res.text()).matchAll(/(?:src|href)="(\\/assets\\/[^"]+)"/g)) files.add(m[1]);
    await Promise.all([...files].map((f) => fetch(f).then((r) => keep(new Request(f), r)).catch(() => undefined)));
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(${JSON.stringify(SCAN_SHELL_CACHE)}) && k !== CACHE).map((k) => caches.delete(k)))));
});
const keep = async (req, res) => {
  if (res.status === 200 && !res.redirected) await (await caches.open(CACHE)).put(req, res.clone());
  return res;
};
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate' && url.pathname === DOC) {
    e.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(no, 3000))]);
        return await keep(new Request(DOC), res);
      } catch {
        return (await caches.match(DOC)) || fetch(req);
      }
    })());
  } else if (url.pathname.startsWith('/assets/') || url.pathname === '/scan.webmanifest') {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))));
  }
});
`;
