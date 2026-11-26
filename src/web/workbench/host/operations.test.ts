import { describe, expect, it, vi } from 'vitest';
import { createTestOperationsClient } from './operations.ts';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const setup = () => {
  const fetch = vi.fn(async () => json({ items: [] }));
  const client = createTestOperationsClient({
    orgId: 'org_1',
    token: async () => 'pbtry_abc',
    drop: () => undefined,
    fetch,
  });
  const headersOf = (call: number) =>
    new Headers((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].headers);
  return { client, fetch, headersOf };
};

describe('the tray client on the Workbench token', () => {
  it('marks its polling reads as the portal’s own, so the request log keeps them out of Calls', async () => {
    const { client, headersOf } = setup();
    await client.list({ active: true });
    expect(headersOf(0).get('x-passbook-client')).toBe('portal');
    expect(headersOf(0).get('authorization')).toBe('Bearer pbtry_abc');
  });

  it('leaves a person’s own action unmarked', async () => {
    const { client, fetch, headersOf } = setup();
    fetch.mockResolvedValueOnce(json({ id: 'op_1' }));
    await client.cancel('op_1');
    expect(headersOf(0).get('x-passbook-client')).toBeNull();
  });
});
