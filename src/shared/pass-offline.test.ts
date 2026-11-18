import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_SCRIPT, PASS_SW_SOURCE, SAVED_MAX_DAYS } from './pass-offline.ts';

const ORIGIN = 'https://wallet.test';
const TOKEN = 'abcdefghijklmnop0123';
const PATH = `/p/${TOKEN}/barcode`;
const URL_ = `${ORIGIN}${PATH}`;
const DAY = 864e5;

const tick = () => new Promise((r) => setTimeout(r, 0));
const hashOf = async (token: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const NAME = async () => `barcode:${await hashOf(TOKEN)}`;

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const store = (name: string) => {
    const found = stores.get(name);
    if (found) return found;
    const created = new Map<string, Response>();
    stores.set(name, created);
    return created;
  };
  return {
    stores,
    has: async (name: string) => stores.has(name),
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => ({
      put: async (key: string, res: Response) => {
        store(name).set(key, res);
      },
      match: async (key: string) => store(name).get(key)?.clone(),
    }),
  };
}
type Caches = ReturnType<typeof fakeCaches>;

/** Runs the worker's source against fakes. */
function loadWorker(caches: Caches, fetchImpl: () => Promise<Response>) {
  let onFetch: (e: unknown) => void = () => {};
  const self = {
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: { unregister: vi.fn(async () => true) },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'fetch') onFetch = fn;
    },
  };
  new Function('self', 'location', 'caches', 'fetch', PASS_SW_SOURCE)(
    self,
    self.location,
    caches,
    fetchImpl,
  );
  const request = (url: string, init: { method?: string; mode?: string } = {}) => {
    let answer: Promise<Response> | null = null;
    onFetch({
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'navigate' },
      respondWith: (p: Promise<Response>) => {
        answer = p;
      },
    });
    return answer as Promise<Response> | null;
  };
  return { self, request };
}

const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });
const redirect = () => {
  const res = new Response(null, { status: 200 });
  Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
  Object.defineProperty(res, 'ok', { value: false });
  Object.defineProperty(res, 'status', { value: 0 });
  return res;
};

afterEach(() => vi.useRealTimers());

/** A saved copy as the page's Save would write it. */
async function seed(caches: Caches, at = Date.now(), expires = '0') {
  await (await caches.open(await NAME())).put(
    `${ORIGIN}/p/saved`,
    page('saved', 200, { 'x-saved-at': String(at), 'x-expires-at': expires }),
  );
}

describe('the barcode page worker', () => {
  it('leaves other routes, methods and non-navigations alone', () => {
    const w = loadWorker(fakeCaches(), vi.fn());
    expect(w.request(`${ORIGIN}/p/${TOKEN}`)).toBeNull();
    expect(w.request(`${ORIGIN}/p/${TOKEN}/pass.pkpass`)).toBeNull();
    expect(w.request(`${ORIGIN}/scan`)).toBeNull();
    expect(w.request(`https://other.test${PATH}`)).toBeNull();
    expect(w.request(URL_, { mode: 'cors' })).toBeNull();
    expect(w.request(URL_, { method: 'POST' })).toBeNull();
  });

  it('stores nothing until the holder saved the page', async () => {
    const caches = fakeCaches();
    const w = loadWorker(caches, async () => page('live'));
    expect(await (await w.request(URL_))?.text()).toBe('live');
    expect(caches.stores.size).toBe(0);
  });

  it('keeps no token string in Cache Storage', async () => {
    const caches = fakeCaches();
    await seed(caches);
    const w = loadWorker(caches, async () => page('fresh'));
    await w.request(`${URL_}?x=1`);
    const names = [...caches.stores.keys()];
    const keys = [...(caches.stores.get(names[0] ?? '')?.keys() ?? [])];
    expect([...names, ...keys].join(' ')).not.toContain(TOKEN);
    // A query string does not add a second entry.
    expect(keys).toEqual([`${ORIGIN}/p/saved`]);
  });

  it('refreshes a saved copy and serves it when the network fails', async () => {
    const caches = fakeCaches();
    await seed(caches);
    let online = true;
    const w = loadWorker(caches, async () => {
      if (!online) throw new TypeError('offline');
      return page('fresh<div data-expires="1999999999999">');
    });
    expect(await (await w.request(URL_))?.text()).toContain('fresh');
    online = false;
    const offline = await w.request(URL_);
    expect(await offline?.text()).toContain('fresh');
    expect(offline?.headers.get('x-expires-at')).toBe('1999999999999');
  });

  it.each([500, 503, 408, 429])('serves the saved copy on %s', async (status) => {
    const caches = fakeCaches();
    await seed(caches);
    const w = loadWorker(caches, async () => page('boom', status));
    expect(await (await w.request(URL_))?.text()).toBe('saved');
    expect(w.self.registration.unregister).not.toHaveBeenCalled();
  });

  it.each([404, 410, 403, 401, 409, 421, 301, 308])(
    'clears the copy and the registration on %s',
    async (status) => {
      const caches = fakeCaches();
      await seed(caches);
      const w = loadWorker(caches, async () => page('gone', status));
      expect((await w.request(URL_))?.status).toBe(status);
      expect(caches.stores.size).toBe(0);
      expect(w.self.registration.unregister).toHaveBeenCalledOnce();
    },
  );

  it('clears the copy on an opaque redirect', async () => {
    const caches = fakeCaches();
    await seed(caches);
    const w = loadWorker(caches, async () => redirect());
    await w.request(URL_);
    expect(caches.stores.size).toBe(0);
    expect(w.self.registration.unregister).toHaveBeenCalledOnce();
  });

  it('refuses a copy past the pass expiry or 30 days, and deletes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    for (const [at, expires] of [
      [now - (SAVED_MAX_DAYS + 1) * DAY, '0'],
      [now - DAY, String(now - 1)],
    ] as const) {
      const caches = fakeCaches();
      await seed(caches, at, expires);
      const w = loadWorker(caches, async () => {
        throw new TypeError('offline');
      });
      const res = await w.request(URL_);
      expect(res?.status).toBe(503);
      expect(await res?.text()).toContain('Connect to refresh this pass.');
      expect(caches.stores.size).toBe(0);
      expect(w.self.registration.unregister).toHaveBeenCalledOnce();
    }
  });
});

type El = {
  hidden: boolean;
  disabled: boolean;
  listeners: Record<string, () => Promise<void>>;
  addEventListener: (t: string, f: () => Promise<void>) => void;
};

/** The page script against a fake DOM, registry and cache; `pathname` is the page's own. */
async function loadPage(
  caches: Caches,
  fetchImpl: () => Promise<Response>,
  ready = Promise.resolve(),
) {
  const el = (hidden: boolean): El => {
    const b: El = {
      hidden,
      disabled: false,
      listeners: {},
      addEventListener(t, f) {
        b.listeners[t] = f;
      },
    };
    return b;
  };
  const parts = { save: el(false), drop: el(true), state: el(true), fail: el(true) };
  const box = {
    hidden: true,
    querySelector: (sel: string) => parts[/data-(\w+)/.exec(sel)?.[1] as keyof typeof parts],
  };
  const reg = { unregister: vi.fn(async () => true) };
  const sw = {
    register: vi.fn(async () => reg),
    ready,
    getRegistration: vi.fn(async () => reg),
  };
  new Function('document', 'navigator', 'window', 'caches', 'location', 'fetch', OFFLINE_SCRIPT)(
    { querySelector: () => box },
    { serviceWorker: sw },
    { caches },
    caches,
    { pathname: PATH, origin: ORIGIN },
    fetchImpl,
  );
  await tick();
  return { box, parts, sw, reg };
}
describe('the barcode page controls', () => {
  it('saves only the page, scoped to its own path, then removes it', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () => page('the page <i data-expires="4102444800000">'));
    expect(p.box.hidden).toBe(false);
    await p.parts.save.listeners.click?.();
    expect(p.sw.register).toHaveBeenCalledWith('/p/sw.js', { scope: PATH });
    expect([...caches.stores.keys()]).toEqual([await NAME()]);
    const entry = caches.stores.get(await NAME())?.get(`${ORIGIN}/p/saved`);
    expect(entry?.headers.get('x-expires-at')).toBe('4102444800000');
    expect(p.parts.drop.hidden).toBe(false);
    await p.parts.drop.listeners.click?.();
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
    expect(p.parts.save.hidden).toBe(false);
  });

  it('writes nothing until the worker is active', async () => {
    const caches = fakeCaches();
    let activate: () => void = () => {};
    const p = await loadPage(
      caches,
      async () => page('x'),
      new Promise<void>((r) => {
        activate = r;
      }),
    );
    const saving = p.parts.save.listeners.click?.();
    await tick();
    expect(caches.stores.size).toBe(0);
    activate();
    await saving;
    expect(caches.stores.size).toBe(1);
  });

  it('keeps nothing, unregisters and says so when the page does not load', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () => page('gone', 404));
    await p.parts.save.listeners.click?.();
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
    expect(p.parts.fail.hidden).toBe(false);
  });

  it('stays hidden where the browser has no service workers', async () => {
    const box = { hidden: true, querySelector: vi.fn() };
    new Function('document', 'navigator', 'window', 'caches', 'location', 'fetch', OFFLINE_SCRIPT)(
      { querySelector: () => box },
      {},
      {},
      undefined,
      { pathname: PATH, origin: ORIGIN },
      vi.fn(),
    );
    await tick();
    expect(box.hidden).toBe(true);
  });
});

describe('save, void, offline, online', () => {
  it('shows the saved copy offline, then clears it once the server says the pass is gone', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () => page('the barcode'));
    await p.parts.save.listeners.click?.();
    let mode: 'void' | 'offline' = 'offline';
    const w = loadWorker(caches, async () => {
      if (mode === 'offline') throw new TypeError('offline');
      return page('Pass unavailable', 404);
    });
    // Offline after the void: the saved copy still shows (the door refuses it).
    expect(await (await w.request(URL_))?.text()).toBe('the barcode');
    // Back online: the server answers 404, so the copy and the worker go.
    mode = 'void';
    expect((await w.request(URL_))?.status).toBe(404);
    expect(caches.stores.size).toBe(0);
    expect(w.self.registration.unregister).toHaveBeenCalledOnce();
    expect(await (await w.request(URL_))?.text()).toBe('Pass unavailable');
  });
});
