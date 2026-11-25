import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLedger, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe('lookup confirmedGrants (R1e)', () => {
  it('lists a read-back grant in both lists and a pending grant only in grants', async () => {
    const { api, pocket } = setup('v2');
    pocket.addUser('u1', { groups: ['g-dev'] });
    await seedGrant('u1', 'developer');
    await env.DB.prepare(
      "INSERT INTO idp_grants (subject, target, source, created_at) VALUES ('u1', 'console', 'added', 1)",
    ).run();
    const l = await api.lookup('u1');
    expect([...l.grants].sort()).toEqual(['console', 'developer']);
    expect(l.confirmedGrants).toEqual(['developer']);
  });

  it('leaves a removed grant out of both', async () => {
    const { api, pocket } = setup('v2');
    pocket.addUser('u1', { groups: [] });
    await seedGrant('u1', 'developer');
    await env.DB.prepare('UPDATE idp_grants SET removed_at = 2').run();
    const l = await api.lookup('u1');
    expect(l.grants).toEqual([]);
    expect(l.confirmedGrants).toEqual([]);
  });
});
