import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';

const ORIGIN = 'https://passbook.mobile';
const app = createApp({ stores: fakeAuth(ORIGIN).stores, hostPolicy: true });
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  app.request(
    `${ORIGIN}/developers/search-miss`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: raw ?? JSON.stringify(body),
    },
    env as unknown as AppEnv,
  );

/** Every line the Worker wrote to its logs while `act` ran. */
async function logged(act: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  await act();
  for (const spy of spies) spy.mockRestore();
  return lines.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('POST /developers/search-miss', () => {
  it('logs the term and nothing else', async () => {
    let status = 0;
    const out = await logged(async () => {
      status = (await post({ term: '  Refund   Policy ' })).status;
    });
    expect(status).toBe(204);
    const line = out.split('\n').find((l) => l.includes('developers.search_miss')) ?? '';
    expect(JSON.parse(line)).toMatchObject({ term: 'refund policy' });
    expect(line).not.toMatch(/cookie|authorization|email|ip/i);
  });

  it('drops anything that is not plain words, even when a client sends it: keys, tokens, ids, addresses, links', async () => {
    const secrets = [
      'pb_test_9fK2xQ7mLp3sD8vA9fK2',
      'Authorization: Bearer pb_live_ab12_cdefghijkl',
      'pbp_x',
      'pbtry_abc.def',
      'wlt_9fK2xQ7mLp3sD8vA',
      '0193a1b2-7c00-7000-8000-0000000000c1',
      '8a1b2c3d4e5f6a7b-LHR',
      'maya@example.com',
      'https://example.com/pass',
      'x'.repeat(61),
    ];
    const out = await logged(async () => {
      for (const term of secrets) expect((await post({ term })).status).toBe(204);
    });
    expect(out).not.toContain('developers.search_miss');
    for (const term of secrets) expect(out).not.toContain(term);
  });

  it('refuses another origin, a body that is not the shape, and a flood from one network', async () => {
    expect((await post({ term: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ nope: 1 })).status).toBe(400);
    expect((await post(null, {}, 'not json')).status).toBe(400);
    expect((await post({ term: 'a'.repeat(5000) })).status).toBe(400);
    const flood = await Promise.all(
      Array.from({ length: 40 }, () =>
        post({ term: 'refund' }, { 'cf-connecting-ip': '203.0.113.9' }),
      ),
    );
    expect(flood.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });
});
