import { describe, expect, it, vi } from 'vitest';
import { keyApi } from './api.ts';

describe('the Keys tool is Test only', () => {
  it('sends Test on every call and mints only a personal Test key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const api = keyApi('csrf', fetchFn);
    await api.mint({ orgId: 'o', name: 'n', scopes: ['passes:read'], expiresAt: 1 });
    await api.roll('o', 'k', 24);
    await api.revoke('o', 'k');
    expect(seen).toHaveLength(3);
    for (const { init } of seen)
      expect((init.headers as Record<string, string>)['x-passbook-mode']).toBe('test');
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      kind: 'personal',
      mode: 'test',
    });
  });
});
