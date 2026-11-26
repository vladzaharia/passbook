import { describe, expect, it } from 'vitest';
import { UpstreamError, ValidationError } from '../../platform/errors.ts';
import { signWebhook } from '../lib/hmac.ts';
import { ConnectorError } from '../types.ts';
import { decodeCursor } from './cursor.ts';
import { harness, NOW, type Sec } from './harness.ts';
import connector from './index.ts';

const base = { baseUrl: 'https://api.example.com/v1' };

describe('http-json config', () => {
  it.each([
    [{ baseUrl: 'https://api.example.com?x=1' }],
    [{ baseUrl: 'https://u:p@api.example.com' }],
    [{ ...base, recordPath: '/members' }],
    [{ ...base, recordPath: '/a/../{ref}' }],
    [{ ...base, recordPath: '/{ref}/{ref}' }],
    [{ ...base, recordPointer: '/a~2' }],
    [{ ...base, auth: { type: 'header', headerName: 'Host' } }],
    [{ ...base, auth: { type: 'header', headerName: 'bad header' } }],
  ])('rejects %j', (config) => {
    expect(connector.configSchema.safeParse(config).success).toBe(false);
  });

  it('applies defaults', () => {
    const c = connector.configSchema.parse(base);
    expect(c.recordPath).toBe('/{ref}');
    expect(c.auth.type).toBe('none');
    expect(connector.version).toBe(2);
    expect(connector.displayName).toBe('REST API');
  });

  it('has no per-record path of its own when a list is configured', () => {
    expect(connector.configSchema.parse({ ...base, list: { path: '/l' } }).recordPath).toBe(
      undefined,
    );
  });

  it.each([
    [{ ...base, headers: [{ name: 'Authorization', value: 'x' }] }],
    [{ ...base, headers: [{ name: 'X-Api-Key', value: 'x' }] }],
    [{ ...base, headers: [{ name: 'X-Auth-Token', value: 'x' }] }],
    [{ ...base, headers: [{ name: 'Cookie', value: 'x' }] }],
    [{ ...base, headers: [{ name: 'Notion-Version', value: 'a\r\nb' }] }],
    [{ ...base, headers: Array.from({ length: 6 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })) }],
    [{ ...base, list: { path: '/l', listing: 'feed', incremental: { param: 's', field: '/u' } } }],
    [{ ...base, list: { path: '/l', maxPages: 1001 } }],
  ])('rejects %j', (config) => {
    expect(connector.configSchema.safeParse(config).success).toBe(false);
  });
});

describe('http-json fetchRecord', () => {
  const record = { member: { name: 'Alex', email: 'Alex@Example.com' }, tier: 'gold' };

  it('GETs the URL template with the ref encoded and extracts the record and holder email', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        recordPath: '/members/{ref}',
        recordPointer: '/member',
        holderEmailPointer: '/member/email',
      },
      {},
      () => ({ body: record }),
    );
    const res = await connector.fetchRecord(ctx, 'a b/c'.replace('/', '-'));
    expect(calls[0]?.url).toBe('https://api.example.com/v1/members/a%20b-c');
    expect(res).toEqual({
      status: 'ok',
      record: record.member,
      holderEmail: 'alex@example.com',
    });
  });

  it('rejects refs that could change the path', async () => {
    const { ctx, calls } = harness(base);
    for (const ref of ['..', 'a/../b', 'a/b', '%2e%2e/x'.replace('%2e%2e', '..')]) {
      await expect(connector.fetchRecord(ctx, ref)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('preserves a malformed nonempty holder email for downstream rejection', async () => {
    const { ctx } = harness({ ...base, holderEmailPointer: '/email' }, {}, () => ({
      body: { email: 'not-an-email', a: 1 },
    }));
    expect(await connector.fetchRecord(ctx, 'x')).toEqual({
      status: 'ok',
      record: { email: 'not-an-email', a: 1 },
      holderEmail: 'not-an-email',
    });
  });

  it.each([null, '', '  ', undefined])(
    'omits an absent or empty holder email (%s)',
    async (email) => {
      const { ctx } = harness({ ...base, holderEmailPointer: '/email' }, {}, () => ({
        body: { email, a: 1 },
      }));
      const result = await connector.fetchRecord(ctx, 'x');
      expect(result.status).toBe('ok');
      expect(result).not.toHaveProperty('holderEmail');
    },
  );

  it.each([0, false, {}, []])('rejects a non-string holder email (%j)', async (email) => {
    const { ctx } = harness({ ...base, holderEmailPointer: '/email' }, {}, () => ({
      body: { email, a: 1 },
    }));
    await expect(connector.fetchRecord(ctx, 'x')).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });

  it('maps 404 to not_found', async () => {
    const { ctx } = harness(base, {}, () => ({ status: 404 }));
    expect(await connector.fetchRecord(ctx, 'x')).toEqual({ status: 'not_found' });
  });

  it.each([
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM'],
    [400, 'UPSTREAM'],
  ])('maps HTTP %i to %s without echoing the body', async (status, code) => {
    const { ctx } = harness(base, {}, () => ({
      status,
      body: 'secret upstream text',
      headers: { 'retry-after': '7' },
    }));
    const err = await connector.fetchRecord(ctx, 'x').catch((e: ConnectorError) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(code);
    expect((err as ConnectorError).httpStatus).toBe(status);
    expect((err as ConnectorError).message).not.toContain('secret');
    if (code === 'RATE_LIMITED') expect((err as ConnectorError).retryAfterMs).toBe(7000);
  });

  it('maps transport failures from safe-fetch', async () => {
    const timeout = harness(base, {}, () => ({ throws: new UpstreamError('t', 'TIMEOUT') }));
    await expect(connector.fetchRecord(timeout.ctx, 'x')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    const redirect = harness(base, {}, () => ({
      throws: new UpstreamError('r', 'REDIRECT_BLOCKED'),
    }));
    await expect(connector.fetchRecord(redirect.ctx, 'x')).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
    const unsafe = harness(base, {}, () => ({
      throws: new ValidationError('u', [], 'UNSAFE_URL'),
    }));
    await expect(connector.fetchRecord(unsafe.ctx, 'x')).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('rejects non-JSON and non-object payloads', async () => {
    const text = harness(base, {}, () => ({ body: '<html>' }));
    await expect(connector.fetchRecord(text.ctx, 'x')).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    const arr = harness(base, {}, () => ({ body: [1, 2] }));
    await expect(connector.fetchRecord(arr.ctx, 'x')).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});

describe('http-json auth', () => {
  const header = async (config: object, secrets: Sec) => {
    const { ctx, calls } = harness({ ...base, ...config }, secrets);
    await connector.fetchRecord(ctx, 'x');
    return calls[0]?.headers ?? {};
  };

  it('sends bearer, basic and custom header credentials', async () => {
    expect(await header({ auth: { type: 'bearer' } }, { token: 'tok' })).toMatchObject({
      authorization: 'Bearer tok',
    });
    expect(
      await header({ auth: { type: 'basic' } }, { username: 'u', password: 'p' }),
    ).toMatchObject({
      authorization: `Basic ${btoa('u:p')}`,
    });
    expect(
      await header({ auth: { type: 'header', headerName: 'X-Api-Key' } }, { headerValue: 'k' }),
    ).toMatchObject({ 'x-api-key': 'k' });
    expect(await header({}, {})).not.toHaveProperty('authorization');
  });

  it('fails with CONFIG when the secret for the chosen auth type is missing', async () => {
    const { ctx, calls } = harness({ ...base, auth: { type: 'bearer' } }, {});
    await expect(connector.fetchRecord(ctx, 'x')).rejects.toMatchObject({ code: 'CONFIG' });
    expect(calls).toHaveLength(0);
  });
});

describe('http-json listChanges (v1 configs through migrate)', () => {
  // A stored v1 config as the old schema parsed it, migrated the way the runtime does.
  const v1 = (list: Record<string, unknown>) =>
    connector.migrate?.(1, {
      ...base,
      recordPath: '/{ref}',
      list: {
        cursorParam: 'cursor',
        cursorPointer: '/cursor',
        itemsPointer: '/items',
        refPointer: '/id',
        recordPointer: '',
        ...list,
      },
    }) as Record<string, unknown>;
  const list = { path: '/members/changes', deletedPointer: '/deleted', recordPointer: '/data' };
  const page1 = {
    items: [{ id: 'a', data: { memberName: 'A' } }, { id: 'b', deleted: true }, { id: 7 }],
    cursor: 'c2',
  };
  const stateOf = (cursor: string | undefined) => decodeCursor(cursor ?? null).state;

  it('resumes a v1 raw cursor, embeds records and flags deletions', async () => {
    const { ctx, calls } = harness(v1(list), {}, (url) =>
      url.searchParams.get('cursor') === 'c1'
        ? { body: page1 }
        : { body: { items: [], cursor: '' } },
    );
    const res = await connector.listChanges?.(ctx, 'c1');
    expect(calls[0]?.url).toBe('https://api.example.com/v1/members/changes?cursor=c1');
    expect(res?.changes).toEqual([
      { ref: 'a', record: { memberName: 'A' } },
      { ref: 'b', deleted: true },
      { ref: '7' },
    ]);
    expect(res?.hasMore).toBe(true);
    expect(stateOf(res?.cursor)).toMatchObject({ p: { c: 'c2', k: 1 } });
  });

  it('stops when the cursor does not advance and keeps it for the next run', async () => {
    const { ctx } = harness(v1(list), {}, () => ({ body: { items: [], cursor: 'c1' } }));
    const res = await connector.listChanges?.(ctx, 'c1');
    expect(res?.hasMore).toBe(false);
    expect(stateOf(res?.cursor)).toEqual({ p: { c: 'c1' } });
  });

  it('honors hasMorePointer and rejects a malformed page', async () => {
    const more = harness(v1({ ...list, hasMorePointer: '/more' }), {}, () => ({
      body: { items: [{ id: 'a' }], cursor: 'n', more: false },
    }));
    const res = await connector.listChanges?.(more.ctx, null);
    expect(res?.hasMore).toBe(false);
    expect(stateOf(res?.cursor)).toEqual({ p: { c: 'n' } });
    const bad = harness(v1(list), {}, () => ({ body: { nope: 1 } }));
    await expect(connector.listChanges?.(bad.ctx, null)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });

  it('fails with CONFIG when no list endpoint is configured', async () => {
    const { ctx } = harness(base);
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({ code: 'CONFIG' });
  });
});

describe('http-json test()', () => {
  it('probes the list endpoint, the test ref, or just validates', async () => {
    const list = harness({ ...base, list: { path: '/l' } }, {}, () => ({ body: { items: [] } }));
    expect((await connector.test?.(list.ctx))?.detail).toMatch(/List endpoint/);
    const ref = harness({ ...base, testRef: 'abc' }, {}, () => ({ status: 404 }));
    expect((await connector.test?.(ref.ctx))?.detail).toMatch(/not found/);
    const none = harness(base);
    expect((await connector.test?.(none.ctx))?.detail).toMatch(/no test target/);
  });

  it('surfaces auth failure', async () => {
    const { ctx } = harness({ ...base, testRef: 'a' }, {}, () => ({ status: 401 }));
    await expect(connector.test?.(ctx)).rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('http-json verifyWebhook', () => {
  const secret = 'whsec_abcdefghijklmnop';
  const ts = Math.floor(NOW / 1000);

  async function hook(body: unknown, over: { secret?: string; ts?: number } = {}) {
    const text = JSON.stringify(body);
    const stamp = over.ts ?? ts;
    return new Request('https://x.test/hooks/connections/c1', {
      method: 'POST',
      body: text,
      headers: {
        'x-wallet-timestamp': String(stamp),
        'x-wallet-signature': await signWebhook(over.secret ?? secret, stamp, text),
      },
    });
  }

  it('returns the event id and de-duplicated refs', async () => {
    const { ctx } = harness(base, {}, undefined, secret);
    const res = await connector.verifyWebhook?.(
      ctx,
      await hook({ id: 'evt-1', refs: ['a', 'b', 'a', 3] }),
    );
    expect(res).toEqual({ eventId: 'evt-1', refs: ['a', 'b', '3'] });
  });

  it('declares refs-only and fetches webhook refs from the source', async () => {
    const { ctx, calls } = harness(base, {}, () => ({ body: { name: 'Alex' } }), secret);
    const res = await connector.verifyWebhook?.(ctx, await hook({ id: 'evt-1', refs: ['a'] }));
    expect(connector.webhookReferenceMode).toBe('refs-only');
    expect(res).toEqual({ eventId: 'evt-1', refs: ['a'] });
    expect(await connector.fetchRecord(ctx, 'a')).toMatchObject({
      status: 'ok',
      record: { name: 'Alex' },
    });
    expect(calls.map((call) => call.url)).toEqual(['https://api.example.com/v1/a']);
  });

  it('derives a stable event id from the signature when the body has none', async () => {
    const { ctx } = harness(base, {}, undefined, secret);
    const first = await connector.verifyWebhook?.(ctx, await hook({ refs: ['a'] }));
    const second = await connector.verifyWebhook?.(ctx, await hook({ refs: ['a'] }));
    expect(first?.eventId).toMatch(/^sig:/);
    expect(first?.eventId).toBe(second?.eventId);
  });

  it('rejects bad signatures, stale timestamps and missing secrets', async () => {
    const { ctx } = harness(base, {}, undefined, secret);
    await expect(
      connector.verifyWebhook?.(ctx, await hook({ refs: [] }, { secret: 'wrong-secret-wrong' })),
    ).rejects.toMatchObject({ code: 'AUTH' });
    await expect(
      connector.verifyWebhook?.(ctx, await hook({ refs: [] }, { ts: ts - 3600 })),
    ).rejects.toMatchObject({ code: 'AUTH' });
    const none = harness(base);
    await expect(
      connector.verifyWebhook?.(none.ctx, await hook({ refs: [] })),
    ).rejects.toMatchObject({
      code: 'AUTH',
    });
  });

  it('rejects malformed refs and too many refs', async () => {
    const { ctx } = harness(base, {}, undefined, secret);
    await expect(connector.verifyWebhook?.(ctx, await hook({ refs: 'a' }))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(connector.verifyWebhook?.(ctx, await hook({ refs: [{}] }))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
    await expect(connector.verifyWebhook?.(ctx, await hook({ refs: many }))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});
