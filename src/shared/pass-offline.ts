import { HOLDER_COPY } from './copy/holder.ts';

/**
 * Save to this phone: an offline copy of one pass's door view (/p/<token>/barcode). The page is a
 * bearer credential, so the copy is narrow:
 * - opt-in: only "Save to this phone" on the pass page writes it, and "Remove from this phone" (or
 *   a 404/410 from the server, or the pass page itself finding the pass ended, or a dead
 *   /p link's 404 page) deletes it; signing out of the portal deletes them all;
 * - one cache per token, named by a hash of it (`barcode:<sha256>`), holding the page's own HTML
 *   under one fixed key and nothing else. The page carries no token (relative links only), so no
 *   token string sits in Cache Storage, in a name, a key or a body. The hash is a name, not a
 *   protection: any same-origin script can list the caches and read the barcode;
 * - the copy is shown offline for at most 7 days, and never past the pass's own expiry (sent as
 *   the x-pass-expires-at header);
 * - the server's answer wins: network first, and only a failed network, 408, 429 or a 5xx falls back
 *   to the copy. Any redirect or other 4xx (404, 410, a host policy 421, a 403) deletes it;
 * - the worker is registered with the page's own path as scope and answers only a navigation to
 *   exactly /p/<token>/barcode, so it never sees other routes (the scanner's worker lives elsewhere).
 * The door still verifies on the server; a saved copy of a voided pass is refused there.
 */
export const PASS_SW_PATH = '/p/sw.js';
/** The Trusted Types policy save.js makes (security-headers.ts allows it on /p, /b and the app). */
export const SAVE_POLICY = 'passbook-save';
/** The pass page's and the portal's save controls (one source: this file). */
export const PASS_SAVE_PATH = '/p/save.js';

/** How long a saved copy may be shown, counted from the last time the server confirmed it. */
export const SAVED_MAX_DAYS = 7;

/** The header the door view sends with the pass's own expiry (ms), when it has one. */
export const EXPIRES_HEADER = 'x-pass-expires-at';

/** Shared by the worker and the page scripts: the cache's one key, its name, and how a copy is written. */
const HELPERS = `const KEY = location.origin + '/p/saved';
const hashOf = async (token) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (b) => b.toString(16).padStart(2, '0')).join('');
async function keep(name, res) {
  const text = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('x-saved-at', String(Date.now()));
  headers.set('x-expires-at', res.headers.get('${EXPIRES_HEADER}') || '0');
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
  return new Response(EXPIRED, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
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

/**
 * The save controls, served at /p/save.js for the pass page and the portal alike. `mount(root)`
 * wires every `[data-save-phone]` host in root; the host's `data-save` is idle (absent), busy,
 * saved or failed, and CSS does the rest. Only the door view's own path is ever registered or
 * fetched, and only when it is on this origin. A host marked `data-save-ended` (a pass that no
 * longer works) drops any saved copy instead.
 */
export const PASS_SAVE_SOURCE = `(() => {
  if (window.PassSave) return;
${HELPERS}  const TOKEN = /^\\/p\\/([A-Za-z0-9_-]{16,128})\\/barcode$/;
  const can = () => 'serviceWorker' in navigator && 'caches' in window && !!(window.crypto && crypto.subtle);
  const pathOf = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.origin === location.origin && TOKEN.test(u.pathname) ? u.pathname : null;
    } catch {
      return null;
    }
  };
  // The page's CSP requires Trusted Types: one policy that admits only the worker's address.
  let policy;
  const swUrl = () => {
    if (!window.trustedTypes) return '${PASS_SW_PATH}';
    policy ??= window.trustedTypes.createPolicy('${SAVE_POLICY}', {
      createScriptURL: (u) => {
        if (u !== '${PASS_SW_PATH}') throw new TypeError('Unexpected script address.');
        return u;
      },
    });
    return policy.createScriptURL('${PASS_SW_PATH}');
  };
  const nameOf = async (path) => 'barcode:' + (await hashOf(path.split('/')[2]));
  const clear = async (path) => {
    await caches.delete(await nameOf(path));
    const reg = await navigator.serviceWorker.getRegistration(path);
    if (reg) await reg.unregister();
  };
  const save = async (path) => {
    try {
      // Not serviceWorker.ready: it waits on the worker for this page's URL, and this page is not
      // in the door view's scope.
      const reg = await navigator.serviceWorker.register(swUrl(), { scope: path });
      const worker = reg.installing || reg.waiting || reg.active;
      if (worker && worker.state !== 'activated') {
        await new Promise((resolve, reject) => {
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve();
            else if (worker.state === 'redundant') reject(new Error('worker'));
          });
        });
      }
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok || res.redirected) throw new Error('save');
      await keep(await nameOf(path), res);
    } catch (e) {
      await clear(path);
      throw e;
    }
  };
  const replay = (host) => {
    const buddy = host.querySelector('[data-when="saved"] [data-scene="tuck"]');
    if (!buddy || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    buddy.removeAttribute('data-run');
    buddy.getBoundingClientRect();
    buddy.setAttribute('data-run', '');
  };
  const sheet = (host, open) => {
    const dlg = host.querySelector('[data-save-sheet]');
    if (!dlg) return;
    if (!open) return dlg.close ? dlg.close() : dlg.removeAttribute('open');
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
  };
  const mount = (root) => {
    for (const host of (root || document).querySelectorAll('[data-save-phone]:not([data-save-ready])')) {
      const path = pathOf(host.getAttribute('data-save-phone'));
      if (!path || !can()) continue;
      host.setAttribute('data-save-ready', '');
      nameOf(path).then((name) => caches.has(name)).then((on) => {
        if (on) host.setAttribute('data-save', 'saved');
      }, () => {});
      host.addEventListener('click', async (e) => {
        const el = e.target && e.target.closest ? e.target : null;
        const act = el && el.closest('[data-save-do],[data-save-drop],[data-save-done]');
        if (!act || !host.contains(act)) return;
        e.preventDefault();
        if (act.hasAttribute('data-save-done')) return sheet(host, false);
        if (host.getAttribute('data-save') === 'busy') return;
        if (act.hasAttribute('data-save-drop')) {
          await clear(path);
          host.removeAttribute('data-save');
          return;
        }
        host.setAttribute('data-save', 'busy');
        try {
          await save(path);
          host.setAttribute('data-save', 'saved');
          replay(host);
          sheet(host, true);
        } catch {
          // Nothing was kept (save() cleared it); the failed state says so.
          host.setAttribute('data-save', 'failed');
        }
      });
    }
    for (const host of (root || document).querySelectorAll('[data-save-ended]')) {
      const path = pathOf(host.getAttribute('data-save-ended'));
      if (path && can()) clear(path).catch(() => {});
    }
  };
  // Sign-out: every saved copy and its worker go, whatever pass it was.
  const clearAll = async () => {
    for (const name of await caches.keys()) if (name.startsWith('barcode:')) await caches.delete(name);
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      if (TOKEN.test(new URL(reg.scope).pathname)) await reg.unregister();
    }
  };
  window.PassSave = { mount, clearAll };
  // A sign-out form (Switch account) posts only after this phone's saved passes are cleared.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const action = form && form.getAttribute ? form.getAttribute('action') || '' : '';
    if (!/^\\/auth\\/logout(\\?|$)/.test(action)) return;
    e.preventDefault();
    Promise.race([clearAll(), new Promise((r) => setTimeout(r, 1500))]).catch(() => {}).then(() => form.submit());
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(document));
  else mount(document);
})();
`;

/**
 * The door view's own script: shows "Works offline" when this device holds a saved copy, keeps the
 * screen awake where the browser has Screen Wake Lock. Nothing here touches the network.
 */
export const DOOR_SCRIPT = `(() => {
${HELPERS}  const note = document.querySelector('[data-door-saved]');
  if (note && 'caches' in window && window.crypto && crypto.subtle) {
    hashOf(location.pathname.split('/')[2])
      .then((h) => caches.has('barcode:' + h))
      .then((on) => { note.hidden = !on; }, () => {});
  }
  if ('wakeLock' in navigator) {
    const hold = () => navigator.wakeLock.request('screen').catch(() => {});
    hold();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') hold();
    });
  }
})();
`;

/**
 * On the 404 page of a /p/<token> or /p/<token>/barcode link (rotated, voided, ended): drops that
 * token's saved copy and its worker, so the phone stops showing a code the server has retired.
 */
export const DROP_SCRIPT = `(() => {
${HELPERS}  const m = /^\\/p\\/([A-Za-z0-9_-]{16,128})(\\/barcode)?$/.exec(location.pathname);
  if (!m || !('caches' in window) || !window.crypto || !crypto.subtle) return;
  hashOf(m[1])
    .then((h) => caches.delete('barcode:' + h))
    .then(() => navigator.serviceWorker && navigator.serviceWorker.getRegistration('/p/' + m[1] + '/barcode'))
    .then((reg) => reg && reg.unregister())
    .catch(() => {});
})();
`;
