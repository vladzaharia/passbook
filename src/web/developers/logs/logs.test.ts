import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { fill, getJson, h } from './dom.ts';
import { logsIsland, railIsland } from './entry.ts';
import { builderLink, loadOps } from './ops.ts';
import { entry, expand, json, open, page, rowsOf } from './test-support.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  it('links a logged route to the console, in the document spelling', () => {
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

  it('the islands leave a signed-out page as it was', async () => {
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

describe('the request log rows', () => {
  it('reads Yours by default: your key’s calls, not the portal’s own reads', async () => {
    const { calls } = await open([page([entry(1)])]);
    expect(calls[0]).toContain('source=key');
  });

  it('stays as prerendered when signed out, and offers the quickstart without a sandbox', async () => {
    const out = await open([json({}, 401)]);
    expect(out.el.textContent).toBe('prerendered');
    const none = await open([json({}, 404)]);
    expect(none.el.textContent).toContain(LOGS_COPY.noSandbox);
    expect(none.el.querySelector('a')?.textContent).toBe(LOGS_COPY.create);
    const failed = await open([json({}, 500)]);
    expect(failed.el.textContent).toContain(LOGS_COPY.notLoaded);
  });

  it('puts one call on one line: time, method, the path cut in the middle, code, status and duration', async () => {
    const long = '/api/v1/webhook-endpoints/01a21159-de5d-7fd9-91ff-508b01a4310d/captures';
    const { el } = await open([
      page([
        entry(1),
        entry(2, { method: 'DELETE', status: 404, code: 'NOT_FOUND', query: null }),
        entry(3, { method: 'GET', path: long, query: 'limit=50', status: 503, durationMs: 2400 }),
      ]),
    ]);
    const rows = rowsOf(el);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('.logs-path')?.textContent).toBe('/passes/p1?a=1');
    expect(rows[0]?.querySelector('.logs-time')?.getAttribute('title')).toMatch(
      /^\w{3} \d+, \d{4}, /,
    );
    expect(rows[1]?.querySelector('.method')?.textContent).toBe('DEL');
    expect(rows[1]?.querySelector('.logs-code')?.textContent).toBe('NOT_FOUND');
    expect(rows[1]?.dataset.tone).toBe('warning');
    expect(rows[1]?.querySelector('.pill')?.className).toContain('warning');
    const where = rows[2]?.querySelector('.logs-where');
    expect(where?.getAttribute('title')).toBe(
      '/webhook-endpoints/01a21159-de5d-7fd9-91ff-508b01a4310d/captures?limit=50',
    );
    expect(where?.querySelector('.logs-tail')?.textContent).toBe('/captures?limit=50');
    expect(where?.querySelector('.logs-id')?.textContent).toBe(
      '01a21159-de5d-7fd9-91ff-508b01a4310d',
    );
    expect(rows[2]?.dataset.tone).toBe('danger');
    expect(rows[2]?.querySelector('.logs-ms')?.hasAttribute('data-slow')).toBe(true);
    expect(rows[2]?.querySelector('.logs-ms')?.textContent).toBe('2.4 s');
  });

  it('marks a call sent from the portal, and tells Run here from the portal’s own reads', async () => {
    const { el } = await open([
      page([entry(1, { via: 'try', client: null }), entry(2, { via: 'try', client: 'portal' })]),
    ]);
    const marks = [...el.querySelectorAll('.logs-via')].map((m) => m.getAttribute('title'));
    expect(marks).toEqual([LOGS_COPY.detail.via, LOGS_COPY.detail.portal]);
  });

  it('shows no Load more when there is no more, and counts what is shown', async () => {
    const { el } = await open([page([entry(1), entry(2)])]);
    expect(el.querySelector<HTMLButtonElement>('.logs-foot button')?.hidden).toBe(true);
    expect(el.querySelector('.logs-foot')?.textContent).toContain(LOGS_COPY.count(2));
  });

  it('loads the next page with its cursor, appends it, and hides Load more at the end', async () => {
    const { el, calls } = await open([page([entry(1)], { nextCursor: 'c1' }), page([entry(2)])]);
    const more = el.querySelector<HTMLButtonElement>('.logs-foot button');
    expect(more?.hidden).toBe(false);
    more?.click();
    await vi.waitFor(() => expect(rowsOf(el)).toHaveLength(2));
    expect(calls.at(-1)).toContain('cursor=c1');
    expect(more?.hidden).toBe(true);
    expect(el.querySelector('.logs-foot')?.textContent).toContain(LOGS_COPY.count(2));
  });

  it('says when the log is full', async () => {
    const { el } = await open([page([entry(1)], { capped: 'hour' })]);
    const note = el.querySelector<HTMLElement>('.logs-full');
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toBe(LOGS_COPY.capped.hour);
  });

  it('moves between rows with the arrow keys', async () => {
    const { el } = await open([page([entry(1), entry(2)])]);
    const [a, b] = [...el.querySelectorAll<HTMLElement>('.logs-row > summary')];
    a?.focus();
    a?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(b);
    b?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(a);
  });
});

describe('an opened row', () => {
  const detail = (over: Record<string, unknown> = {}) =>
    json({
      ...entry(1, { code: 'INVALID_INPUT', status: 422 }),
      requestBody: '{"a":1}',
      responseBody: '{"code":"INVALID_INPUT"}',
      bodiesExpireAt: Date.now() + 3600_000,
      ...over,
    });

  it('shows the exchange once: request line, stamp, tinted bodies, the console and the error guide', async () => {
    const { el, calls } = await open([page([entry(1, { code: 'INVALID_INPUT', status: 422 })])], {
      detail: detail(),
    });
    const row = rowsOf(el)[0];
    expand(row);
    await vi.waitFor(() => expect(row?.querySelector('.logs-x')).not.toBeNull());
    const panes = row?.querySelectorAll('.logs-pane');
    expect(panes?.[0]?.querySelector('.logs-line')?.textContent).toBe('POST /api/v1/passes/p1?a=1');
    expect(panes?.[0]?.textContent).toContain('curl/8.7.1');
    expect(panes?.[0]?.querySelector('pre .k')?.textContent).toBe('"a"');
    expect(panes?.[1]?.querySelector('.stamp')?.textContent).toBe('422 Unprocessable');
    expect(panes?.[1]?.querySelector('.stamp')?.className).toContain('warn');
    const links = [...(row?.querySelectorAll('.logs-acts a') ?? [])].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual([
      '/developers/console#passes.postPassesById',
      '/developers/errors/INVALID_INPUT',
    ]);
    expect(row?.textContent).toContain('req-1');
    // The strip's own key is named by its prefix.
    expect(row?.querySelector('.logs-facts')?.textContent).toContain('pb_test_ab12');
    expect(row?.textContent).toContain(LOGS_COPY.detail.expires);
    expand(row);
    expect(calls.filter((c) => c.includes('logs/log-1'))).toHaveLength(1);
  });

  it('copies the call as curl, with the key from the environment and the logged body', async () => {
    const { el } = await open([page([entry(1)])], { detail: detail() });
    const row = rowsOf(el)[0];
    expand(row);
    await vi.waitFor(() => expect(row?.querySelector('.logs-acts')).not.toBeNull());
    const curl = row?.querySelector('[data-copy-text^="curl"]')?.getAttribute('data-copy-text');
    expect(curl).toContain(`curl -X POST '${location.origin}/api/v1/passes/p1?a=1'`);
    expect(curl).toContain('Bearer $PASSBOOK_KEY');
    expect(curl).toContain(`-d '{\n  "a": 1\n}'`);
    expect(row?.querySelector('[data-copy-text="req-1"]')?.getAttribute('aria-label')).toBe(
      LOGS_COPY.detail.copyId,
    );
  });

  it('says so when the bodies are gone, and when the detail fails', async () => {
    const gone = await open([page([entry(1)])], {
      detail: detail({
        hasBodies: false,
        requestBody: null,
        responseBody: null,
        bodiesExpireAt: null,
      }),
    });
    const row = rowsOf(gone.el)[0];
    expand(row);
    await vi.waitFor(() => expect(row?.textContent).toContain(LOGS_COPY.detail.bodiesGone));
    expect(row?.querySelector('pre')).toBeNull();
    const bad = await open([page([entry(1)])]);
    const row2 = rowsOf(bad.el)[0];
    expand(row2);
    await vi.waitFor(() => expect(row2?.textContent).toContain(LOGS_COPY.failed));
  });
});
