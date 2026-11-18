import { HOLDER_COPY } from './copy/holder.ts';

/**
 * Offline copy of one pass's barcode page. The page is a bearer credential, so the copy is narrow:
 * - opt-in: only the Save button writes it, and Remove (or a 404/410 from the server) deletes it;
 * - one cache per token, named by a hash of it (`barcode:<sha256>`), so no token string sits in Cache
 *   Storage, holding the page's own HTML under one fixed key and nothing else;
 * - the copy is shown offline for at most 30 days, and never past the pass's own expiry;
 * - the server's answer wins: network first, and only a failed network, 408, 429 or a 5xx falls back
 *   to the copy. Any redirect or other 4xx (404, 410, a host policy 421, a 403) deletes it;
 * - the worker is registered with the page's own path as scope and answers only a navigation to
 *   exactly /p/<token>/barcode, so it never sees other routes (the scanner's worker lives elsewhere).
 * The door still verifies on the server; a saved copy of a voided pass is refused there.
 */
export const PASS_SW_PATH = '/p/sw.js';

/** How long a saved copy may be shown, counted from the last time the server confirmed it. */
export const SAVED_MAX_DAYS = 30;

/** Shared by the worker and the page: the cache name, its one key, and how a copy is written. */
const HELPERS = `const KEY = location.origin + '/p/saved';
const hashOf = async (token) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (b) => b.toString(16).padStart(2, '0')).join('');
async function keep(name, res) {
  const text = await res.text();
  const expires = /data-expires="(\\d+)"/.exec(text);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('x-saved-at', String(Date.now()));
  headers.set('x-expires-at', expires ? expires[1] : '0');
  await (await caches.open(name)).put(KEY, new Response(text, { status: 200, headers }));
}
`;

const EXPIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${HOLDER_COPY.connectToRefresh}</title><p style="font:16px system-ui;margin:2rem">${HOLDER_COPY.connectToRefresh}</p>`;

export const PASS_SW_SOURCE = `${HELPERS}const PAGE = /^\\/p\\/([A-Za-z0-9_-]{16,128})\\/barcode$/;
const MAX = ${SAVED_MAX_DAYS} * 864e5;
const EXPIRED = ${JSON.stringify(EXPIRED_PAGE)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  const m = url.origin === location.origin ? PAGE.exec(url.pathname) : null;
  if (m) e.respondWith(serve(req, m[1]));
});
async function drop(name) {
  await caches.delete(name);
  await self.registration.unregister();
}
async function saved(name) {
  const hit = await (await caches.open(name)).match(KEY);
  if (!hit) return null;
  const at = Number(hit.headers.get('x-saved-at'));
  const expires = Number(hit.headers.get('x-expires-at')) || Infinity;
  if (Date.now() < Math.min(at + MAX, expires)) return hit;
  await drop(name);
  return new Response(EXPIRED, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
async function serve(req, token) {
  const name = 'barcode:' + (await hashOf(token));
  if (!(await caches.has(name))) return fetch(req);
  let res;
  try {
    res = await fetch(req);
  } catch {
    return (await saved(name)) || Response.error();
  }
  if (res.ok) {
    await keep(name, res.clone());
    return res;
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) return (await saved(name)) || res;
  await drop(name);
  return res;
}
`;

/** The page's Save / Remove controls; hidden until the script confirms the browser can do it. */
export const OFFLINE_SCRIPT = `${HELPERS}(async () => {
  const box = document.querySelector('[data-offline]');
  if (!box || !('serviceWorker' in navigator) || !('caches' in window)) return;
  const path = location.pathname;
  const name = 'barcode:' + (await hashOf(path.split('/')[2]));
  const [save, drop, state, fail] = ['save', 'drop', 'state', 'fail'].map((k) => box.querySelector('[data-' + k + ']'));
  const show = (on) => {
    save.hidden = on;
    drop.hidden = !on;
    state.hidden = !on;
  };
  const clear = async () => {
    await caches.delete(name);
    const reg = await navigator.serviceWorker.getRegistration(path);
    if (reg) await reg.unregister();
  };
  box.hidden = false;
  caches.has(name).then(show, () => {});
  save.addEventListener('click', async () => {
    save.disabled = true;
    fail.hidden = true;
    try {
      await navigator.serviceWorker.register('${PASS_SW_PATH}', { scope: path });
      await navigator.serviceWorker.ready;
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok || res.redirected) throw new Error('save');
      await keep(name, res);
      show(true);
    } catch {
      await clear();
      fail.hidden = false;
    }
    save.disabled = false;
  });
  drop.addEventListener('click', async () => {
    await clear();
    show(false);
  });
})();
`;
