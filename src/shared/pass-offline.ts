/**
 * Offline copy of one pass's barcode page. The page is a bearer credential, so the copy is narrow:
 * - opt-in: only the Save button writes it, and Remove (or a 404/410 from the server) deletes it;
 * - one cache per token (`barcode:<token>`) holding the page's own HTML and nothing else;
 * - the worker is registered with the page's own path as scope and answers only a navigation to
 *   exactly /p/<token>/barcode, so it never sees other routes (the scanner's worker lives elsewhere).
 * The door still verifies on the server; a saved copy of a voided pass is refused there.
 */
export const PASS_SW_PATH = '/p/sw.js';

export const PASS_SW_SOURCE = `const PAGE = /^\\/p\\/([A-Za-z0-9_-]{16,128})\\/barcode$/;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  const m = url.origin === self.location.origin ? PAGE.exec(url.pathname) : null;
  if (m) e.respondWith(serve(req, 'barcode:' + m[1]));
});
async function serve(req, name) {
  if (!(await caches.has(name))) return fetch(req);
  const saved = async () => (await caches.open(name)).match(req.url, { ignoreSearch: true });
  let res;
  try {
    res = await fetch(req);
  } catch {
    return (await saved()) || Response.error();
  }
  if (res.status === 404 || res.status === 410) {
    await caches.delete(name);
    await self.registration.unregister();
    return res;
  }
  if (res.ok) {
    await (await caches.open(name)).put(req.url, res.clone());
    return res;
  }
  return (await saved()) || res;
}
`;

/** The page's Save / Remove controls; hidden until the script confirms the browser can do it. */
export const OFFLINE_SCRIPT = `(() => {
  const box = document.querySelector('[data-offline]');
  if (!box || !('serviceWorker' in navigator) || !('caches' in window)) return;
  const path = location.pathname;
  const name = 'barcode:' + path.split('/')[2];
  const [save, drop, state, fail] = ['save', 'drop', 'state', 'fail'].map((k) => box.querySelector('[data-' + k + ']'));
  const show = (on) => {
    save.hidden = on;
    drop.hidden = !on;
    state.hidden = !on;
  };
  box.hidden = false;
  caches.has(name).then(show, () => {});
  save.addEventListener('click', async () => {
    save.disabled = true;
    fail.hidden = true;
    try {
      await navigator.serviceWorker.register('${PASS_SW_PATH}', { scope: path });
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error('save');
      await (await caches.open(name)).put(path, res);
      show(true);
    } catch {
      await caches.delete(name);
      fail.hidden = false;
    }
    save.disabled = false;
  });
  drop.addEventListener('click', async () => {
    await caches.delete(name);
    const reg = await navigator.serviceWorker.getRegistration(path);
    if (reg) await reg.unregister();
    show(false);
  });
})();
`;
