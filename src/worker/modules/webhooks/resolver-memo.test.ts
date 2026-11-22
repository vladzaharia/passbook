import { describe, expect, it } from 'vitest';
import { resolverFor } from './resolver-memo.ts';

const TABLE = 'hooks.example.com=93.184.216.34, other.example.com=203.0.113.9';
const now = () => 0;

describe('resolverFor', () => {
  it('answers pinned hosts when the base URL is plain-http loopback', async () => {
    const r = resolverFor(
      { WEBHOOK_TEST_DNS: TABLE, PUBLIC_BASE_URL: 'http://localhost:6060' },
      now,
    );
    expect(await r.resolve('hooks.example.com')).toEqual(['93.184.216.34']);
    expect(await r.resolve('unknown.example.com')).toEqual([]);
  });

  it('ignores the table on any other base URL, so production never uses it', async () => {
    for (const base of [
      'https://passbook.mobile',
      'http://passbook.mobile',
      'http://localhost.evil.test',
      undefined,
    ]) {
      const env = { WEBHOOK_TEST_DNS: TABLE, ...(base ? { PUBLIC_BASE_URL: base } : {}) };
      // Not pinned: it asks DNS-over-HTTPS, which no test may reach.
      const original = globalThis.fetch;
      let asked = false;
      globalThis.fetch = (async () => {
        asked = true;
        return new Response('{}');
      }) as typeof fetch;
      try {
        const r = resolverFor(env, now);
        await r.resolve(`probe-${Math.random()}.example.com`).catch(() => undefined);
      } finally {
        globalThis.fetch = original;
      }
      expect(asked).toBe(true);
    }
  });
});
