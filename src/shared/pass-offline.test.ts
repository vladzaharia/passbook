import { describe, expect, it, vi } from 'vitest';
import { OFFLINE_SCRIPT, PASS_SW_SOURCE } from './pass-offline.ts';

const TOKEN = 'abcdefghijklmnop0123';
const URL_ = `https://wallet.test/p/${TOKEN}/barcode`;

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
      put: async (key: string | Request, res: Response) => {
        store(name).set(typeof key === 'string' ? key : key.url, res);
      },
      match: async (key: string) => store(name).get(key)?.clone(),
    }),
  };
}

/** Runs the worker's source against fakes and returns what it registered. */
function loadWorker(caches: ReturnType<typeof fakeCaches>, fetchImpl: typeof fetch) {
  let onFetch: (e: unknown) => void = () => {};
  const self = {
    location: { origin: 'https://wallet.test' },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: { unregister: vi.fn(async () => true) },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'fetch') onFetch = fn;
    },
  };
  new Function('self', 'caches', 'fetch', 'Response', 'URL', PASS_SW_SOURCE)(
    self,
    caches,
    fetchImpl,
    Response,
    URL,
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

const page = (body: string, status = 200) => new Response(body, { status });

describe('the barcode page worker', () => {
  it('leaves other routes, methods and non-navigations alone', () => {
    const w = loadWorker(fakeCaches(), vi.fn());
    expect(w.request('https://wallet.test/p/abcdefghijklmnop0123')).toBeNull();
    expect(w.request('https://wallet.test/p/abcdefghijklmnop0123/pass.pkpass')).toBeNull();
    expect(w.request('https://wallet.test/scan')).toBeNull();
    expect(w.request('https://other.test/p/abcdefghijklmnop0123/barcode')).toBeNull();
    expect(w.request(URL_, { mode: 'cors' })).toBeNull();
    expect(w.request(URL_, { method: 'POST' })).toBeNull();
  });

  it('stores nothing until the holder saved the page', async () => {
    const caches = fakeCaches();
    const w = loadWorker(
      caches,
      vi.fn(async () => page('live')),
    );
    expect(await (await w.request(URL_))?.text()).toBe('live');
    expect(caches.stores.size).toBe(0);
  });

  it('refreshes a saved copy and serves it when the network fails', async () => {
    const caches = fakeCaches();
    await (await caches.open(`barcode:${TOKEN}`)).put(URL_, page('saved'));
    let online = true;
    const w = loadWorker(
      caches,
      vi.fn(async () => {
        if (!online) throw new TypeError('offline');
        return page('fresh');
      }),
    );
    expect(await (await w.request(URL_))?.text()).toBe('fresh');
    online = false;
    expect(await (await w.request(URL_))?.text()).toBe('fresh');
    expect([...caches.stores.keys()]).toEqual([`barcode:${TOKEN}`]);
  });

  it('serves the saved copy on a server error', async () => {
    const caches = fakeCaches();
    await (await caches.open(`barcode:${TOKEN}`)).put(URL_, page('saved'));
    const w = loadWorker(
      caches,
      vi.fn(async () => page('boom', 503)),
    );
    expect(await (await w.request(URL_))?.text()).toBe('saved');
  });

  it.each([404, 410])('clears the copy and the registration on %s', async (status) => {
    const caches = fakeCaches();
    await (await caches.open(`barcode:${TOKEN}`)).put(URL_, page('saved'));
    const w = loadWorker(
      caches,
      vi.fn(async () => page('gone', status)),
    );
    const res = await w.request(URL_);
    expect(res?.status).toBe(status);
    expect(caches.stores.size).toBe(0);
    expect(w.self.registration.unregister).toHaveBeenCalledOnce();
  });
});

type Btn = { hidden: boolean; disabled: boolean; listeners: Record<string, () => Promise<void>> };

/** The page script against a fake DOM, registry and cache. */
function loadPage(caches: ReturnType<typeof fakeCaches>, fetchImpl: typeof fetch) {
  const el = (
    hidden: boolean,
  ): Btn & { addEventListener: (t: string, f: () => Promise<void>) => void } => {
    const b = {
      hidden,
      disabled: false,
      listeners: {} as Record<string, () => Promise<void>>,
      addEventListener(t: string, f: () => Promise<void>) {
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
    getRegistration: vi.fn(async () => reg),
  };
  new Function('document', 'navigator', 'window', 'caches', 'location', 'fetch', OFFLINE_SCRIPT)(
    { querySelector: () => box },
    { serviceWorker: sw },
    { caches },
    caches,
    { pathname: `/p/${TOKEN}/barcode` },
    fetchImpl,
  );
  return { box, parts, sw, reg };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the barcode page controls', () => {
  it('saves only the page, scoped to its own path, then removes it', async () => {
    const caches = fakeCaches();
    const p = loadPage(
      caches,
      vi.fn(async () => page('the page')),
    );
    await tick();
    expect(p.box.hidden).toBe(false);
    await p.parts.save.listeners.click?.();
    expect(p.sw.register).toHaveBeenCalledWith('/p/sw.js', { scope: `/p/${TOKEN}/barcode` });
    expect([...caches.stores.keys()]).toEqual([`barcode:${TOKEN}`]);
    expect([...(caches.stores.get(`barcode:${TOKEN}`)?.keys() ?? [])]).toEqual([
      `/p/${TOKEN}/barcode`,
    ]);
    expect(p.parts.drop.hidden).toBe(false);
    await p.parts.drop.listeners.click?.();
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
    expect(p.parts.save.hidden).toBe(false);
  });

  it('keeps nothing and says so when the page does not load', async () => {
    const caches = fakeCaches();
    const p = loadPage(
      caches,
      vi.fn(async () => page('gone', 404)),
    );
    await p.parts.save.listeners.click?.();
    expect(caches.stores.size).toBe(0);
    expect(p.parts.fail.hidden).toBe(false);
  });

  it('stays hidden where the browser has no service workers', () => {
    const box = { hidden: true, querySelector: vi.fn() };
    new Function('document', 'navigator', 'window', 'caches', 'location', 'fetch', OFFLINE_SCRIPT)(
      { querySelector: () => box },
      {},
      {},
      undefined,
      { pathname: '/p/x/barcode' },
      vi.fn(),
    );
    expect(box.hidden).toBe(true);
  });
});
