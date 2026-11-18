import { describe, expect, it } from 'vitest';
import { applyMapping } from '../../modules/connections/mapping.ts';
import { UpstreamError } from '../../platform/errors.ts';
import type { SafeFetch, SafeResponse } from '../../platform/safe-fetch.ts';
import { assertSafeUrl } from '../../platform/safe-fetch.ts';
import { type ConnectorContext, ConnectorError } from '../types.ts';
import connector from './index.ts';

type Cfg = ReturnType<typeof connector.configSchema.parse>;

const URL_ = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';

function harness(csv: string | (() => string), over: { status?: number; throws?: Error } = {}) {
  const logs: { event: string; data?: unknown }[] = [];
  const calls: string[] = [];
  const fetch: SafeFetch = async (url) => {
    calls.push(url);
    if (over.throws) throw over.throws;
    const bytes = new TextEncoder().encode(typeof csv === 'function' ? csv() : csv);
    return {
      status: over.status ?? 200,
      headers: new Headers(),
      body: bytes,
      text: () => new TextDecoder().decode(bytes),
      json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    } satisfies SafeResponse;
  };
  const ctx: ConnectorContext<Cfg, unknown> = {
    connection: {
      id: 'c1',
      orgId: 'o1',
      generation: 1,
      config: connector.configSchema.parse({ url: URL_, idColumn: 'Id' }),
    },
    secrets: undefined,
    now: () => 0,
    fetch,
    signal: new AbortController().signal,
    log: (event, data) => logs.push({ event, data }),
  };
  return { ctx, logs, calls };
}

const sheet = (n: number, extra = '') =>
  `Id,Name,Email\n${Array.from({ length: n }, (_, i) => `A${i},Name ${i},n${i}@x.co`).join('\n')}${extra}`;

describe('csv-url config', () => {
  it.each([
    [{ url: 'http://docs.example.com/a.csv', idColumn: 'Id' }],
    [{ url: 'https://u:p@docs.example.com/a.csv', idColumn: 'Id' }],
    [{ url: 'https://docs.example.com/a.csv#frag', idColumn: 'Id' }],
    [{ url: URL_, idColumn: '' }],
    [{ url: URL_ }],
  ])('refuses %j', (cfg) => expect(connector.configSchema.safeParse(cfg).success).toBe(false));

  it('allows a query string, and names its one fetched url for the save-time check', () => {
    const c = connector.configSchema.parse({ url: URL_, idColumn: 'Id' });
    expect(connector.urls?.(c)).toEqual([URL_]);
    expect(() => assertSafeUrl(URL_)).not.toThrow();
    expect(() => assertSafeUrl('https://10.0.0.1/a.csv')).toThrow();
    expect(() => assertSafeUrl('https://localhost/a.csv')).toThrow();
  });

  it('asks for a bounded response and a few redirects', () => {
    expect(connector.defaults).toMatchObject({
      maxResponseBytes: 2_000_000,
      maxRedirects: 3,
      requestsPerMinute: 6,
      maxConcurrency: 1,
    });
  });
});

describe('listChanges', () => {
  it('lists rows as records keyed by header, leaving blank cells out', async () => {
    const { ctx } = harness('Id,Name,Email\nA1,Maya,\nA2,Jo,jo@x.co');
    const r = await connector.listChanges?.(ctx, null);
    expect(r?.changes).toEqual([
      { ref: 'A1', record: { Id: 'A1', Name: 'Maya' } },
      { ref: 'A2', record: { Id: 'A2', Name: 'Jo', Email: 'jo@x.co' } },
    ]);
    expect(r?.hasMore).toBe(false);
    expect(r?.cursor).toMatch(/^2:[0-9a-f]{16}$/);
  });

  it('pages 200 rows at a time on an offset and hash cursor', async () => {
    const { ctx } = harness(sheet(450));
    const first = await connector.listChanges?.(ctx, null);
    expect(first?.changes).toHaveLength(200);
    expect(first?.hasMore).toBe(true);
    const second = await connector.listChanges?.(ctx, first?.cursor ?? null);
    expect(second?.changes[0]?.ref).toBe('A200');
    const third = await connector.listChanges?.(ctx, second?.cursor ?? null);
    expect(third?.changes).toHaveLength(50);
    expect(third?.hasMore).toBe(false);
    // Done: the same file lists nothing more.
    const idle = await connector.listChanges?.(ctx, third?.cursor ?? null);
    expect(idle?.changes).toEqual([]);
  });

  it('starts again at 0 when the file changed under the cursor, or the cursor is broken', async () => {
    let body = sheet(300);
    const { ctx } = harness(() => body);
    const first = await connector.listChanges?.(ctx, null);
    body = sheet(300, '\nB1,New,b@x.co');
    const after = await connector.listChanges?.(ctx, first?.cursor ?? null);
    expect(after?.changes).toHaveLength(200);
    expect(after?.changes[0]?.ref).toBe('A0');
    for (const bad of ['x', '-5:abc', '9999999999999999999:abc', ':']) {
      expect((await connector.listChanges?.(ctx, bad))?.changes[0]?.ref).toBe('A0');
    }
  });

  it('skips rows with no ID and repeated IDs, and logs each with its code', async () => {
    const { ctx, logs } = harness('Id,Name\nA1,One\n,Blank\nA1,Dup\nA2,Two\n  ,Spaces');
    const r = await connector.listChanges?.(ctx, null);
    expect(r?.changes.map((c) => c.ref)).toEqual(['A1', 'A2']);
    expect(r?.changes[0]?.record).toEqual({ Id: 'A1', Name: 'One' });
    expect(logs).toEqual([
      { event: 'csv_row_no_id', data: { code: 'CSV_ROW_NO_ID', rows: 2 } },
      { event: 'csv_row_dup_id', data: { code: 'CSV_ROW_DUP_ID', rows: 1 } },
    ]);
  });

  it('fails the run as a permanent CONFIG when the file has more than 2,000 rows', async () => {
    const { ctx } = harness(sheet(2001));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      code: 'CONFIG',
      permanent: true,
    });
    expect((await connector.listChanges?.(harness(sheet(2000)).ctx, null))?.changes).toHaveLength(
      200,
    );
  });

  it('fails permanently when the ID column is not in the file, and retries other bad files', async () => {
    const noId = harness('Name\nMaya');
    await expect(connector.listChanges?.(noId.ctx, null)).rejects.toMatchObject({
      code: 'CONFIG',
      permanent: true,
    });
    const html = harness('PK\u0003\u0004zip');
    await expect(connector.listChanges?.(html.ctx, null)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      permanent: false,
    });
    const empty = harness('   ');
    await expect(connector.listChanges?.(empty.ctx, null)).rejects.toBeInstanceOf(ConnectorError);
  });

  it('maps HTTP and transport failures to connector codes without echoing the link', async () => {
    for (const [status, code] of [
      [401, 'AUTH'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
      [500, 'UPSTREAM'],
    ] as const)
      await expect(
        connector.listChanges?.(harness('x', { status }).ctx, null),
      ).rejects.toMatchObject({ code });
    const refused = harness('x', { throws: new UpstreamError('x', 'REDIRECT_BLOCKED') });
    const err = await connector.listChanges?.(refused.ctx, null).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'UPSTREAM' });
    expect(String((err as Error).message)).not.toContain('google');
  });
});

describe('fetchRecord and test', () => {
  it('finds a row by ID, or reports it gone', async () => {
    const { ctx } = harness(sheet(3));
    expect(await connector.fetchRecord(ctx, 'A1')).toEqual({
      status: 'ok',
      record: { Id: 'A1', Name: 'Name 1', Email: 'n1@x.co' },
    });
    expect(await connector.fetchRecord(ctx, 'ZZ')).toEqual({ status: 'not_found' });
  });

  it('reports the row count and the columns', async () => {
    const { ctx } = harness(sheet(3));
    expect(await connector.test?.(ctx)).toEqual({
      ok: true,
      detail: '3 rows. Columns: Id, Name, Email',
    });
    const wide = harness(`Id,${Array.from({ length: 11 }, (_, i) => `C${i}`).join(',')}\nA1`);
    expect((await connector.test?.(wide.ctx))?.detail).toBe(
      '1 rows. Columns: Id, C0, C1, C2, C3, C4, C5, C6, …',
    );
  });

  it('never fetches anything but the configured link', async () => {
    const { ctx, calls } = harness(sheet(2));
    await connector.listChanges?.(ctx, null);
    await connector.fetchRecord(ctx, 'A0');
    expect(new Set(calls)).toEqual(new Set([URL_]));
  });
});

describe('mapping through the shared core', () => {
  it('a header becomes a pointer, so the import plan applies unchanged', async () => {
    const { ctx } = harness('Id,Member Name,a/b\nA1,Maya,x');
    const r = await connector.listChanges?.(ctx, null);
    const record = r?.changes[0]?.record ?? {};
    const out = applyMapping({ name: { from: '/Member Name' }, odd: { from: '/a~1b' } }, record);
    expect(out).toEqual({ name: 'Maya', odd: 'x' });
  });
});
