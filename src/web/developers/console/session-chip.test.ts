import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes by url; an Error value is a network failure. */
function route(table: Record<string, Response | Error | (() => Response)>) {
  const fetchMock = vi.fn(async (url: string) => {
    const hit = table[url];
    if (!hit) return json({}, 404);
    if (hit instanceof Error) throw hit;
    return typeof hit === 'function' ? hit() : hit;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session lookup', () => {
  const load = async () => (await import('./session.ts')).loadSession();
  const authed = { authenticated: true, csrfToken: 'csrf-1', roles: ['developer'] };

  it('is signed out without a session, and when the lookup fails', async () => {
    route({ '/api/v1/session': json({ authenticated: false }) });
    expect(await load()).toEqual({ kind: 'out' });
    vi.resetModules();
    route({ '/api/v1/session': new Error('offline') });
    expect(await load()).toEqual({ kind: 'out' });
    vi.resetModules();
    route({ '/api/v1/session': new Response('not json') });
    expect(await load()).toEqual({ kind: 'out' });
  });

  it('reads the session and the sandbox past any cache, so a deleted sandbox is not shown again', async () => {
    const mock = route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': json({ sandbox: null }),
    });
    await load();
    for (const call of mock.mock.calls) {
      expect((call as unknown as [string, RequestInit])[1].cache).toBe('no-store');
    }
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('is signed out when the sandbox route says 401', async () => {
    route({ '/api/v1/session': json(authed), '/api/v1/developer/sandbox': json({}, 401) });
    expect(await load()).toEqual({ kind: 'out' });
  });

  it('has no sandbox yet: the site key comes from the answer, or is empty on an error', async () => {
    route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': json({ sandbox: null, turnstileSiteKey: 'site-1' }),
    });
    expect(await load()).toEqual({ kind: 'none', csrf: 'csrf-1', siteKey: 'site-1' });
    vi.resetModules();
    route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': json({ sandbox: null }),
    });
    expect(await load()).toEqual({ kind: 'none', csrf: 'csrf-1', siteKey: '' });
    vi.resetModules();
  });

  it('is failed, not empty, when the sandbox read errors', async () => {
    route({ '/api/v1/session': json(authed), '/api/v1/developer/sandbox': json({}, 500) });
    expect(await load()).toEqual({ kind: 'failed', csrf: 'csrf-1' });
  });

  it('reads a closed sandbox and a ready one, and asks the server once per page', async () => {
    route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': json({ sandbox: { id: 's', closedAt: 5 } }),
    });
    expect(await load()).toEqual({ kind: 'closed', csrf: 'csrf-1', siteKey: '' });
    vi.resetModules();
    const mock = route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': () =>
        json({ sandbox: { id: 's1', orgId: 'org-1', orgSlug: 'acme', templateId: 't1' } }),
    });
    const { loadSession } = await import('./session.ts');
    const ready = {
      kind: 'ready',
      csrf: 'csrf-1',
      sandbox: { id: 's1', orgId: 'org-1', orgSlug: 'acme', templateId: 't1' },
      siteKey: '',
    };
    expect(await loadSession()).toEqual(ready);
    expect(await loadSession()).toEqual(ready);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('a sandbox without a template has templateId null', async () => {
    route({
      '/api/v1/session': json(authed),
      '/api/v1/developer/sandbox': json({ sandbox: { id: 's1', orgSlug: 'acme' } }),
    });
    expect(await load()).toMatchObject({ sandbox: { templateId: null } });
  });
});

describe('the run data', () => {
  it('fetches a page of operations once, and again after a failure', async () => {
    const { loadFile, loadIndex } = await import('./data.ts');
    let fail = true;
    const mock = route({
      '/developers/run/passes.json': () => (fail ? json({}, 500) : json({ ops: [] })),
      '/developers/run/index.json': json({ pages: [] }),
    });
    await expect(loadFile('passes')).rejects.toThrow('/developers/run/passes.json');
    await Promise.resolve();
    fail = false;
    await expect(loadFile('passes')).resolves.toEqual({ ops: [] });
    await loadFile('passes');
    expect(mock).toHaveBeenCalledTimes(2);
    await expect(loadIndex()).resolves.toEqual({ pages: [] });
    await loadIndex();
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('forgets a failed index so the next call asks again', async () => {
    const { loadIndex } = await import('./data.ts');
    route({ '/developers/run/index.json': json({}, 404) });
    await expect(loadIndex()).rejects.toThrow();
    await Promise.resolve();
    const mock = route({ '/developers/run/index.json': json({ pages: ['a'] }) });
    await expect(loadIndex()).resolves.toEqual({ pages: ['a'] });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('the sandbox check', () => {
  type Opts = {
    callback: (t: string) => void;
    'error-callback': () => void;
    'expired-callback': () => void;
    'before-interactive-callback': () => void;
    'after-interactive-callback': () => void;
    sitekey: string;
  };
  const fakeApi = (run: (o: Opts) => void) => {
    const remove = vi.fn();
    const render = vi.fn((_host: HTMLElement, o: Opts) => {
      run(o);
      return 'w1';
    });
    Object.assign(window, { turnstile: { render, remove } });
    return { render, remove };
  };
  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile;
  });

  it('resolves the token, shows the widget only when it needs the person, and removes it', async () => {
    const shown = vi.fn();
    const { render, remove } = fakeApi((o) => {
      o['before-interactive-callback']();
      o['after-interactive-callback']();
      o.callback('tok');
    });
    const { verify } = await import('./turnstile.ts');
    await expect(verify(document.createElement('div'), 'site-key', shown)).resolves.toBe('tok');
    expect(shown.mock.calls).toEqual([[true], [false]]);
    expect(render.mock.calls[0]?.[1].sitekey).toBe('site-key');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('w1'));
  });

  it.each([
    ['error-callback', 'check'],
    ['expired-callback', 'expired'],
  ] as const)('rejects on %s', async (key, message) => {
    fakeApi((o) => o[key]());
    const { verify } = await import('./turnstile.ts');
    await expect(verify(document.createElement('div'), 'k', vi.fn())).rejects.toThrow(message);
  });

  it('loads the script once, through a trusted-types policy that admits only its address', async () => {
    const policies: { createScriptURL(u: string): string }[] = [];
    Object.assign(window, {
      trustedTypes: {
        createPolicy: (_n: string, rules: { createScriptURL(u: string): string }) => {
          policies.push(rules);
          return rules;
        },
      },
    });
    const { verify } = await import('./turnstile.ts');
    const pending = verify(document.createElement('div'), 'k', vi.fn());
    const script = document.querySelector('script');
    expect(script?.src).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(() => policies[0]?.createScriptURL('https://evil.example/x.js')).toThrow(TypeError);
    fakeApi((o) => o.callback('late'));
    script?.onload?.(new Event('load'));
    await expect(pending).resolves.toBe('late');
    delete (window as { trustedTypes?: unknown }).trustedTypes;
  });

  it('rejects when the script is blocked, and tries again next time', async () => {
    const { verify } = await import('./turnstile.ts');
    const first = verify(document.createElement('div'), 'k', vi.fn());
    document.querySelector('script')?.onerror?.(new Event('error'));
    await expect(first).rejects.toThrow('blocked');
    const second = verify(document.createElement('div'), 'k', vi.fn());
    expect(document.querySelectorAll('script')).toHaveLength(2);
    fakeApi((o) => o.callback('ok'));
    document.querySelectorAll('script')[1]?.onload?.(new Event('load'));
    await expect(second).resolves.toBe('ok');
  });
});
