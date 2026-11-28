import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOOR_SCRIPT,
  DROP_SCRIPT,
  PASS_SAVE_SOURCE,
  PASS_SW_SOURCE,
  SAVED_MAX_DAYS,
} from './pass-offline.ts';

const ORIGIN = 'https://wallet.test';
const TOKEN = 'demodemodemodemodemo';
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
    keys: async () => [...stores.keys()],
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
      return page('fresh', 200, { 'x-pass-expires-at': '1999999999999' });
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

  it('refuses a copy past the pass expiry or 7 days, and deletes it', async () => {
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
      expect(res?.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res?.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res?.text()).toContain('Connect to refresh this pass.');
      expect(caches.stores.size).toBe(0);
      expect(w.self.registration.unregister).toHaveBeenCalledOnce();
    }
  });
});

type Attrs = Record<string, string>;
type Handler = (e: unknown) => Promise<void>;

/** The save script against a fake page: one host, its controls, a registry and a cache. */
async function loadPage(
  caches: Caches,
  fetchImpl: () => Promise<Response>,
  opts: {
    ready?: Promise<void>;
    href?: string;
    ended?: boolean;
    workers?: boolean;
    tt?: unknown;
    win?: Record<string, unknown>;
    regs?: { scope: string; unregister: () => Promise<boolean> }[];
  } = {},
) {
  const attrs: Attrs = {};
  const handlers: Record<string, Handler> = {};
  const host = {
    attrs,
    getAttribute: (k: string) =>
      k === 'data-save-phone' || k === 'data-save-ended' ? (opts.href ?? PATH) : (attrs[k] ?? null),
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    removeAttribute: (k: string) => {
      delete attrs[k];
    },
    contains: () => true,
    addEventListener: (t: string, f: Handler) => {
      handlers[t] = f;
    },
    querySelector: () => null,
  };
  const reg: Record<string, unknown> = { unregister: vi.fn(async () => true) };
  // A worker that finishes activating once `ready` resolves, as a statechange.
  const worker = { state: 'activated', addEventListener: (_t: string, _f: () => void) => {} };
  if (opts.ready !== undefined) {
    let onChange: () => void = () => {};
    worker.state = 'installing';
    worker.addEventListener = (_t, f) => {
      onChange = f;
    };
    reg.installing = worker;
    void opts.ready.then(() => {
      worker.state = 'activated';
      onChange();
    });
  } else {
    reg.active = worker;
  }
  const sw = {
    register: vi.fn(async () => reg),
    getRegistration: vi.fn(async () => reg),
    getRegistrations: vi.fn(async () => opts.regs ?? []),
  };
  const globals: Record<string, unknown> = {};
  const win = opts.win ?? ({ crypto, caches, PassSave: undefined } as Record<string, unknown>);
  if (opts.tt) win.trustedTypes = opts.tt;
  const doc = {
    readyState: 'complete',
    addEventListener: () => {},
    querySelectorAll: (sel: string) =>
      sel.includes('data-save-ended') ? (opts.ended ? [host] : []) : opts.ended ? [] : [host],
  };
  new Function(
    'document',
    'navigator',
    'window',
    'caches',
    'location',
    'fetch',
    'matchMedia',
    'crypto',
    PASS_SAVE_SOURCE,
  )(
    doc,
    opts.workers === false ? {} : { serviceWorker: sw },
    Object.assign(win, globals),
    caches,
    { href: `${ORIGIN}/p/${TOKEN}`, origin: ORIGIN },
    fetchImpl,
    () => ({ matches: true }),
    crypto,
  );
  await tick();
  await tick();
  const press = async (control: string) => {
    const target = { closest: () => ({ hasAttribute: (k: string) => k === control }) };
    await handlers.click?.({ target, preventDefault: () => {} });
  };
  return { host, reg, sw, press, win, state: () => attrs['data-save'] };
}

describe('the save controls', () => {
  it('saves only the door view, scoped to its own path, then removes it', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () =>
      page('the page', 200, { 'x-pass-expires-at': '4102444800000' }),
    );
    expect(p.host.attrs['data-save-ready']).toBe('');
    await p.press('data-save-do');
    expect(p.sw.register).toHaveBeenCalledWith('/p/sw.js', { scope: PATH });
    expect([...caches.stores.keys()]).toEqual([await NAME()]);
    const entry = caches.stores.get(await NAME())?.get(`${ORIGIN}/p/saved`);
    expect(entry?.headers.get('x-expires-at')).toBe('4102444800000');
    expect(p.state()).toBe('saved');
    await p.press('data-save-drop');
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
    expect(p.state()).toBeUndefined();
  });

  it('starts saved when this device already holds a copy', async () => {
    const caches = fakeCaches();
    await seed(caches);
    const p = await loadPage(caches, async () => page('x'));
    expect(p.state()).toBe('saved');
  });

  it('writes nothing until the worker is active', async () => {
    const caches = fakeCaches();
    let activate: () => void = () => {};
    const p = await loadPage(caches, async () => page('x'), {
      ready: new Promise<void>((r) => {
        activate = r;
      }),
    });
    const saving = p.press('data-save-do');
    await tick();
    expect(caches.stores.size).toBe(0);
    expect(p.state()).toBe('busy');
    activate();
    await saving;
    expect(caches.stores.size).toBe(1);
  });

  it('keeps nothing, unregisters and says so when the page does not load', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () => page('gone', 404));
    await p.press('data-save-do');
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
    expect(p.state()).toBe('failed');
  });

  it('refuses a door on another origin or another path, and does nothing without service workers', async () => {
    for (const href of [
      'https://evil.test/p/demodemodemodemodemo/barcode',
      '/p/short/barcode',
      '/passes/1',
    ]) {
      const p = await loadPage(fakeCaches(), vi.fn(), { href });
      expect(p.host.attrs['data-save-ready']).toBeUndefined();
    }
    const none = await loadPage(fakeCaches(), vi.fn(), { workers: false });
    expect(none.host.attrs['data-save-ready']).toBeUndefined();
  });

  it('drops a saved copy from the page of a pass that ended', async () => {
    const caches = fakeCaches();
    await seed(caches);
    const p = await loadPage(caches, async () => page('x'), { ended: true, href: PATH });
    await new Promise((r) => setTimeout(r, 20));
    expect(caches.stores.size).toBe(0);
    expect(p.reg.unregister).toHaveBeenCalled();
  });
});

describe('save.js hardening', () => {
  it('registers the worker through a passbook-save policy that admits only /p/sw.js', async () => {
    const rules: { createScriptURL?: (u: string) => string } = {};
    const tt = {
      createPolicy: vi.fn((_n: string, r: typeof rules) => {
        Object.assign(rules, r);
        return { createScriptURL: (u: string) => r.createScriptURL?.(u) };
      }),
    };
    const p = await loadPage(fakeCaches(), async () => page('x'), { tt });
    await p.press('data-save-do');
    await p.press('data-save-drop');
    await p.press('data-save-do');
    expect(tt.createPolicy).toHaveBeenCalledOnce();
    expect(tt.createPolicy.mock.calls[0]?.[0]).toBe('passbook-save');
    expect(p.sw.register).toHaveBeenCalledWith('/p/sw.js', { scope: PATH });
    expect(() => rules.createScriptURL?.('/evil.js')).toThrow(TypeError);
  });

  it('is safe to load twice', async () => {
    const first = await loadPage(fakeCaches(), vi.fn());
    const again = await loadPage(fakeCaches(), vi.fn(), { win: first.win });
    expect(again.host.attrs['data-save-ready']).toBeUndefined();
    expect(first.win.PassSave).toBeDefined();
  });

  it('clears every saved copy and every door worker on sign-out', async () => {
    const caches = fakeCaches();
    await seed(caches);
    await (await caches.open('other')).put('k', page('keep'));
    const mine = { scope: `${ORIGIN}${PATH}`, unregister: vi.fn(async () => true) };
    const foreign = { scope: `${ORIGIN}/scan/`, unregister: vi.fn(async () => true) };
    const p = await loadPage(caches, vi.fn(), { regs: [mine, foreign] });
    await (p.win.PassSave as { clearAll(): Promise<void> }).clearAll();
    expect([...caches.stores.keys()]).toEqual(['other']);
    expect(mine.unregister).toHaveBeenCalled();
    expect(foreign.unregister).not.toHaveBeenCalled();
  });
});

describe('sign-out forms', () => {
  it('clears the saved passes before a logout form posts, and leaves other forms alone', async () => {
    const caches = fakeCaches();
    await seed(caches);
    let onSubmit: (e: unknown) => void = () => {};
    const win = { crypto, caches } as Record<string, unknown>;
    new Function(
      'document',
      'navigator',
      'window',
      'caches',
      'location',
      'fetch',
      'matchMedia',
      'crypto',
      PASS_SAVE_SOURCE,
    )(
      {
        readyState: 'complete',
        addEventListener: (t: string, f: (e: unknown) => void) => {
          if (t === 'submit') onSubmit = f;
        },
        querySelectorAll: () => [],
      },
      { serviceWorker: { getRegistrations: async () => [] } },
      win,
      caches,
      { href: `${ORIGIN}/`, origin: ORIGIN },
      vi.fn(),
      () => ({ matches: true }),
      crypto,
    );
    const form = (action: string) => ({
      getAttribute: () => action,
      submit: vi.fn(),
    });
    const other = form('/search');
    const prevented = vi.fn();
    onSubmit({ target: other, preventDefault: prevented });
    expect(prevented).not.toHaveBeenCalled();
    const out = form('/auth/logout?next=%2Flogin');
    onSubmit({ target: out, preventDefault: prevented });
    expect(prevented).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(out.submit).toHaveBeenCalled());
    expect(caches.stores.size).toBe(0);
  });
});

describe('the retired-link drop script', () => {
  it("deletes that token's copy and its worker, and only on a pass or door path", async () => {
    for (const [pathname, expected] of [
      [PATH, true],
      [`/p/${TOKEN}`, true],
      ['/p/short', false],
    ] as const) {
      const caches = fakeCaches();
      await seed(caches);
      const reg = { unregister: vi.fn(async () => true) };
      new Function('navigator', 'caches', 'location', 'crypto', 'window', DROP_SCRIPT)(
        { serviceWorker: { getRegistration: async () => reg } },
        caches,
        { pathname },
        crypto,
        { crypto, caches },
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(caches.stores.size).toBe(expected ? 0 : 1);
      expect(reg.unregister).toHaveBeenCalledTimes(expected ? 1 : 0);
    }
  });
});

describe('save, void, offline, online', () => {
  it('shows the saved copy offline, then clears it once the server says the pass is gone', async () => {
    const caches = fakeCaches();
    const p = await loadPage(caches, async () => page('the barcode'));
    await p.press('data-save-do');
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

describe('the door script', () => {
  const run = async (opts: { saved: boolean; wake: boolean }) => {
    const caches = fakeCaches();
    if (opts.saved) await seed(caches);
    // The script hashes with the real async digest, then asks caches.has: wait for that lookup
    // itself, not for a fixed number of timer ticks.
    let looked: (p: Promise<boolean>) => void = () => {};
    const lookup = new Promise<Promise<boolean>>((r) => {
      looked = r;
    });
    const has = caches.has;
    caches.has = (name: string) => {
      const p = has(name);
      looked(p);
      return p;
    };
    const note = { hidden: true };
    const request = vi.fn(async () => ({}));
    const listeners: Record<string, (e: unknown) => void> = {};
    new Function('document', 'navigator', 'window', 'caches', 'location', DOOR_SCRIPT)(
      {
        querySelector: (sel: string) => (sel === '[data-door-saved]' ? note : null),
        addEventListener: () => {},
        visibilityState: 'visible',
      },
      opts.wake ? { wakeLock: { request } } : {},
      {
        crypto,
        caches,
        addEventListener: (t: string, f: (e: unknown) => void) => {
          listeners[t] = f;
        },
      },
      caches,
      { pathname: PATH },
    );
    await await lookup;
    await tick();
    return { note, request, listeners };
  };

  it('says Works offline only where a copy is held', async () => {
    expect((await run({ saved: true, wake: false })).note.hidden).toBe(false);
    expect((await run({ saved: false, wake: false })).note.hidden).toBe(true);
  });

  it('waits out a slow digest before showing the note', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...a) => {
      await new Promise((r) => setTimeout(r, 25));
      return digest(...a);
    });
    try {
      expect((await run({ saved: true, wake: false })).note.hidden).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('holds the screen awake only where the browser can', async () => {
    expect((await run({ saved: false, wake: true })).request).toHaveBeenCalledWith('screen');
    await expect(run({ saved: false, wake: false })).resolves.toBeDefined();
  });
});
