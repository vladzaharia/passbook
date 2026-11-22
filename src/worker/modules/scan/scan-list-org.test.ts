import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { credentialKeysFixture } from './credential-keys-test-fixtures.ts';

const t = credentialKeysFixture();
beforeAll(async () => {
  await t.setup();
});

/** Every scan list that answers a key, with the scope it needs and whether a session pages across orgs. */
const LISTS = [
  { path: '/scan-events', scope: 'scan-setup:read', across: false },
  { path: '/scan-zones', scope: 'scan-setup:read', across: false },
  { path: '/scanning-sessions', scope: 'scan-setup:read', across: true },
  { path: '/scan-setups', scope: 'scan-setup:read', across: true },
  { path: '/scan-staff', scope: 'scanning:admin', across: false },
  { path: '/nfc/keysets', scope: 'nfc:keys', across: false },
] as const;

describe.each(LISTS)('$path: who is the org', ({ path, scope, across }) => {
  const sep = (query: string) => (query ? `${path}?${query}` : path);

  it('gives a platform key 404 ORG_NOT_FOUND, whether it omits orgId or names one', async () => {
    const k = await t.key([scope], { orgId: null, kind: 'platform' });
    for (const query of ['', `orgId=${t.orgId()}`])
      await expectProblem(await t.send('GET', sep(query), k.headers), 404, 'ORG_NOT_FOUND');
  });

  it('lets an org-bound key omit orgId, and gives another org nothing', async () => {
    const k = await t.key([scope]);
    expect((await t.send('GET', sep(''), k.headers)).status).toBe(200);
    expect((await t.send('GET', sep(`orgId=${t.orgId()}`), k.headers)).status).toBe(200);
    const other = await t.send('GET', sep('orgId=0193a1b2-7c00-7000-8000-00000000ffff'), k.headers);
    // A key of one org naming another finds an empty page or a 404, never a row.
    expect([200, 403, 404]).toContain(other.status);
    if (other.status === 200)
      expect(((await other.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it(
    across
      ? 'pages a session across its orgs when it omits orgId'
      : 'answers a session that omits orgId with 422 VALIDATION (invalid_type)',
    async () => {
      const res = await t.fixture.call('GET', sep(''));
      if (across) return expect(res.status).toBe(200);
      await expectProblem(res, 422, 'VALIDATION');
      expect(JSON.stringify(await res.json())).toContain('invalid_type');
    },
  );
});
