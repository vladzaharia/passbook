import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGS_COPY, RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { fill, getJson, h } from './dom.ts';
import { logsIsland, railIsland } from './entry.ts';
import { clock, count, flavour, prettyBody } from './format.ts';
import { mountLogs } from './island.ts';
import { builderLink, loadOps } from './ops.ts';
import { mountRail } from './rail.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('log formatting', () => {
  it('shows the time today and the date before', () => {
    const now = new Date(2026, 10, 20, 15, 0, 0).getTime();
    expect(clock(new Date(2026, 10, 20, 9, 5, 7).getTime(), now)).toBe('09:05:07');
    expect(clock(new Date(2026, 10, 19, 14, 2, 11).getTime(), now)).toBe('Nov 19 14:02');
  });

  it('groups thousands and tones a status', () => {
    expect(count(0)).toBe('0');
    expect(count(1234567)).toBe('1,234,567');
    expect([200, 302, 404, 503].map(flavour)).toEqual(['success', 'info', 'warning', 'danger']);
  });

  it('indents JSON bodies, keeps a marker as it is, and has nothing for none', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('[binary body]')).toBe('[binary body]');
    expect(prettyBody(null)).toBeNull();
    expect(prettyBody('')).toBeNull();
  });
});

describe('dom helpers', () => {
  it('builds elements from text and attributes only', () => {
    const el = h(
      'a',
      { href: '/x', hidden: true, skipped: false, none: undefined },
      'a<b>',
      null,
      h('i'),
    );
    expect(el.getAttribute('href')).toBe('/x');
    expect(el.hasAttribute('hidden')).toBe(true);
    expect(el.hasAttribute('skipped')).toBe(false);
    expect(el.textContent).toBe('a<b>');
    expect(el.querySelector('b')).toBeNull();
  });

  it('replaces the children, dropping empty ones', () => {
    const el = h('div', {}, 'old');
    fill(el, 'new', null, false, h('b'));
    expect(el.innerHTML).toBe('new<b></b>');
  });

  it('returns the status with the body only when the answer is ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (p: string) => (p === '/ok' ? json({ a: 1 }) : json({}, 404))),
    );
    expect(await getJson('/ok')).toEqual({ status: 200, body: { a: 1 } });
    expect(await getJson('/no')).toEqual({ status: 404, body: null });
  });
});

describe('the operation index', () => {
  it('links a logged route to the builder, in the document spelling', () => {
    const index = { 'GET /api/v1/passes/{id}': 'passes.getPassesById' };
    expect(builderLink(index, 'GET', '/api/v1/passes/:id')).toBe(
      '/developers/console#passes.getPassesById',
    );
    expect(builderLink(index, 'POST', '/api/v1/passes/:id')).toBeNull();
    expect(builderLink(index, 'GET', null)).toBeNull();
  });

  it('loads the index, or an empty one when it cannot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ 'GET /x': 'x.get' })),
    );
    expect(await loadOps()).toEqual({ 'GET /x': 'x.get' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 500)),
    );
    expect(await loadOps()).toEqual({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(await loadOps()).toEqual({});
  });

  it('the islands mount the list and the rail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 401)),
    );
    const el = document.createElement('div');
    await logsIsland.mount(el);
    await railIsland.mount(el);
    expect(el.children).toHaveLength(0);
  });
});

describe('the api rail', () => {
  const rail = {
    mode: 'test',
    scopes: ['passes:read', 'passes:write'],
    tier: 'standard',
    limitPerMinute: 1200,
    callsLastHour: 3456,
    key: { id: 'k1', name: 'Sandbox key', prefix: 'pbk_ab12' },
  };
  const mount = async (res: Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    const el = h('aside', {}, 'placeholder');
    await mountRail(el);
    return el;
  };

  it('keeps the placeholder when signed out, and says there is no sandbox on a 404', async () => {
    expect((await mount(json({}, 401))).textContent).toBe('placeholder');
    expect((await mount(json({}, 404))).textContent).toBe(
      `${RAIL_COPY.title}${RAIL_COPY.noSandbox}`,
    );
  });

  it('says it failed on any other error', async () => {
    const el = await mount(json({}, 500));
    expect(el.querySelector('h3')).not.toBeNull();
    expect(el.textContent).not.toBe('placeholder');
  });

  it('shows the key, mode, scopes, tier and calls', async () => {
    const el = await mount(json(rail));
    expect(el.textContent).toContain('Sandbox key · pbk_ab12');
    expect(el.querySelector('.pill')?.textContent).toBe('Test');
    expect([...el.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(rail.scopes);
    expect(el.textContent).toContain('standard · 1,200');
    expect(el.querySelector('strong')?.textContent).toBe('3,456');
  });

  it('says there is no key, and marks a live key', async () => {
    const el = await mount(json({ ...rail, mode: 'live', key: null }));
    expect(el.querySelector('code')).toBeNull();
    expect(el.querySelector('.pill')?.textContent).toBe('Live');
  });
});

describe('the request log', () => {
  const entry = (n: number, over: Record<string, unknown> = {}) => ({
    id: `log-${n}`,
    requestId: `req-${n}`,
    at: Date.now() - n * 1000,
    method: 'POST',
    route: '/api/v1/passes/:id',
    path: '/api/v1/passes/p1',
    query: 'a=1',
    status: 201,
    code: null,
    durationMs: 12,
    keyId: 'key-12345678-xyz',
    mode: 'test',
    via: 'try',
    hasBodies: true,
    ...over,
  });
  const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
    json({ items, nextCursor: null, capped: null, ...extra });

  /** A fetch that answers by path; list answers are consumed in order. */
  function api(lists: Response[], detail?: Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (/logs\/log-/.test(url)) return detail ?? json({}, 500);
        return lists.shift() ?? page([]);
      }),
    );
    return calls;
  }
  const open = async (lists: Response[], detail?: Response) => {
    const calls = api(lists, detail);
    const el = h('div', {}, 'prerendered');
    await mountLogs(el, Promise.resolve({ 'POST /api/v1/passes/{id}': 'passes.postPassesById' }));
    return { el, calls };
  };

  it('stays as prerendered when signed out, and offers the quickstart without a sandbox', async () => {
    const out = await open([json({}, 401)]);
    expect(out.el.textContent).toBe('prerendered');
    const none = await open([json({}, 404)]);
    expect(none.el.textContent).toContain(LOGS_COPY.noSandbox);
    expect(none.el.querySelector('a')?.textContent).toBe(LOGS_COPY.create);
    const failed = await open([json({}, 500)]);
    expect(failed.el.textContent).toContain(LOGS_COPY.notLoaded);
  });

  it('lists the calls with method, path, status and time', async () => {
    const { el } = await open([
      page([entry(1), entry(2, { method: 'DELETE', status: 404, code: 'NOT_FOUND', query: null })]),
    ]);
    const rows = el.querySelectorAll('.logs-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.logs-path')?.textContent).toBe('/passes/p1?a=1');
    expect(rows[1]?.querySelector('.method')?.textContent).toBe('DEL');
    expect(rows[1]?.querySelector('.logs-code')?.textContent).toBe('NOT_FOUND');
    expect(rows[1]?.querySelector('.pill')?.className).toContain('warning');
    expect(el.querySelector('.logs-more button')?.hasAttribute('hidden')).toBe(true);
  });

  it('says when the log is empty and when it is full', async () => {
    const empty = await open([page([])]);
    expect(empty.el.querySelector('.logs-list')?.textContent).toBe(LOGS_COPY.empty);
    const full = await open([page([entry(1)], { capped: 'hour' })]);
    const note = full.el.querySelector<HTMLElement>('.logs-full');
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toBe(LOGS_COPY.capped.hour);
  });

  it('opens a row once: facts, a link to the builder, and the redacted bodies', async () => {
    const detail = json({
      ...entry(1),
      requestBody: '{"a":1}',
      responseBody: null,
      bodiesExpireAt: Date.now() + 3600_000,
    });
    const { el, calls } = await open([page([entry(1)])], detail);
    const row = el.querySelector<HTMLDetailsElement>('.logs-row');
    if (row) row.open = true;
    row?.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(row?.querySelector('.logs-bodies')).not.toBeNull());
    expect(row?.textContent).toContain('req-1');
    expect(row?.textContent).toContain('key-1234');
    expect(row?.querySelector('a')?.getAttribute('href')).toBe(
      '/developers/console#passes.postPassesById',
    );
    expect(row?.querySelector('.logs-bodies pre')?.textContent).toContain('"a": 1');
    expect(row?.textContent).toContain(LOGS_COPY.detail.noBody);
    expect(row?.textContent).toContain(LOGS_COPY.detail.expires);
    row?.dispatchEvent(new Event('toggle'));
    expect(calls.filter((c) => c.includes('log-1'))).toHaveLength(1);
  });

  it('says so when the bodies are gone, and when the detail fails', async () => {
    const gone = await open(
      [page([entry(1)])],
      json({
        ...entry(1, { hasBodies: false, via: null, keyId: null }),
        requestBody: null,
        responseBody: null,
        bodiesExpireAt: null,
      }),
    );
    const row = gone.el.querySelector<HTMLDetailsElement>('.logs-row');
    if (row) row.open = true;
    row?.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(row?.textContent).toContain(LOGS_COPY.detail.bodiesGone));
    const bad = await open([page([entry(1)])]);
    const row2 = bad.el.querySelector<HTMLDetailsElement>('.logs-row');
    if (row2) row2.open = true;
    row2?.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(row2?.textContent).toContain(LOGS_COPY.failed));
  });

  it('filters after a short pause, tells no match from empty, and clears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el, calls } = await open([page([entry(1)]), page([]), page([entry(1)])]);
    const status = el.querySelector<HTMLSelectElement>('[name=status]');
    const code = el.querySelector<HTMLInputElement>('[name=code]');
    if (status) status.value = '4xx';
    status?.dispatchEvent(new Event('change'));
    if (code) code.value = ' not_found ';
    code?.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.at(-1)).toContain('status=4xx');
    expect(calls.at(-1)).toContain('code=NOT_FOUND');
    expect(el.querySelector('.logs-list')?.textContent).toBe(LOGS_COPY.noMatch);
    const form = el.querySelector('form');
    form?.dispatchEvent(new Event('submit', { cancelable: true }));
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent === LOGS_COPY.filters.clear)
      ?.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.at(-1)).not.toContain('status=');
    expect(el.querySelectorAll('.logs-row')).toHaveLength(1);
  });

  it('loads the next page with its cursor and appends it', async () => {
    const { el, calls } = await open([page([entry(1)], { nextCursor: 'c1' }), page([entry(2)])]);
    const more = el.querySelector<HTMLButtonElement>('.logs-more button');
    expect(more?.hidden).toBe(false);
    more?.click();
    await vi.waitFor(() => expect(el.querySelectorAll('.logs-row')).toHaveLength(2));
    expect(calls.at(-1)).toContain('cursor=c1');
    expect(more?.hidden).toBe(true);
  });

  it('shows a failure when a later page cannot load', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el } = await open([page([entry(1)]), json({}, 500)]);
    const method = el.querySelector<HTMLSelectElement>('[name=method]');
    if (method) method.value = 'GET';
    method?.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(300);
    expect(el.querySelector('.logs-list')?.textContent).toBe(LOGS_COPY.failed);
  });
});
