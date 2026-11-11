import { describe, expect, it } from 'vitest';
import { signWebhook } from '../lib/hmac.ts';
import type { ConnectorContext } from '../types.ts';
import connector from './index.ts';

type Cfg = ReturnType<typeof connector.configSchema.parse>;
const NOW = Date.UTC(2026, 0, 1);
const secret = 'whsec_pushpushpushpush';

function ctx(webhookSecret: string | undefined = secret): ConnectorContext<Cfg, undefined> {
  return {
    connection: { id: 'c', orgId: 'o', generation: 1, config: connector.configSchema.parse({}) },
    secrets: undefined,
    ...(webhookSecret ? { webhookSecret } : {}),
    now: () => NOW,
    fetch: async () => {
      throw new Error('webhook-push must not fetch');
    },
    signal: new AbortController().signal,
    log: () => {},
  };
}

async function signed(body: unknown, key = secret) {
  const text = JSON.stringify(body);
  const ts = Math.floor(NOW / 1000);
  return new Request('https://x.test/hooks/connections/c', {
    method: 'POST',
    body: text,
    headers: {
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(key, ts, text),
    },
  });
}

describe('webhook-push', () => {
  it('never fetches', async () => {
    expect(await connector.fetchRecord(ctx(), 'a')).toEqual({ status: 'not_modified' });
  });

  it('extracts records and deletions from a signed body', async () => {
    const res = await connector.verifyWebhook?.(
      ctx(),
      await signed({
        id: 'evt-9',
        records: [
          { ref: 'a', record: { memberName: 'A' } },
          { ref: 'b', deleted: true },
          { ref: 'a', record: { memberName: 'dup' } },
        ],
      }),
    );
    expect(res).toEqual({
      eventId: 'evt-9',
      refs: ['a', 'b'],
      records: { a: { memberName: 'A' } },
      deleted: ['b'],
    });
    expect(connector.webhookReferenceMode).toBe('embedded-required');
    for (const ref of res?.refs ?? []) {
      expect(res?.records?.[ref] !== undefined || res?.deleted?.includes(ref)).toBe(true);
    }
  });

  it('rejects a wrong signature', async () => {
    await expect(
      connector.verifyWebhook?.(ctx(), await signed({ records: [] }, 'another-secret-xxxx')),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('rejects records that are not objects, missing refs and oversize batches', async () => {
    const bad = [
      { records: [{ ref: 'a', record: 'x' }] },
      { records: [{ ref: 'a' }] },
      { records: [{ record: {} }] },
      { records: 'no' },
      { records: Array.from({ length: 101 }, (_, i) => ({ ref: `r${i}`, record: {} })) },
    ];
    for (const body of bad) {
      await expect(connector.verifyWebhook?.(ctx(), await signed(body))).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
    }
  });

  it('test() needs a webhook secret', async () => {
    expect((await connector.test?.(ctx()))?.ok).toBe(true);
    await expect(connector.test?.(ctx(''))).rejects.toMatchObject({ code: 'CONFIG' });
  });
});
