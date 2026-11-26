import { beforeEach, describe, expect, it } from 'vitest';
import { ctx, resetLedger, setup } from './harness.ts';

beforeEach(resetLedger);

describe('client restriction', () => {
  it.each([
    [
      'not restricted',
      (p: ReturnType<typeof setup>['pocket']) => {
        p.s.client.restricted = false;
      },
    ],
    [
      'missing a group',
      (p: ReturnType<typeof setup>['pocket']) => {
        p.s.client.allowed = ['g-console', 'g-dev'];
      },
    ],
    [
      'allowing another group',
      (p: ReturnType<typeof setup>['pocket']) => {
        p.s.client.allowed.push('g-support');
      },
    ],
  ])('warns client_open when the client is %s, and still writes', async (_n, change) => {
    const { api, pocket } = setup();
    change(pocket);
    const health = await api.health();
    expect(health).toMatchObject({ ok: true, warnings: ['client_open'] });
    await expect(api.createSignup({ kind: 'developer' }, ctx())).resolves.toMatchObject({
      tokenId: 'tok-id-1',
    });
  });

  it('warns when the client is not found', async () => {
    const { api } = setup('v2', { PASSBOOK_CLIENT_ID: 'other-client' });
    expect((await api.health()).warnings).toEqual(['client_not_found']);
  });
});
