import { describe, expect, it } from 'vitest';
import { jobGrant } from './authority.ts';
import { codeOf, db, refusal } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { run } from './db.ts';

const FINISH = 'org_mode.job.pass_import.finish';
const grantOf = (x: Awaited<ReturnType<typeof setupGrant>>, over: Record<string, unknown> = {}) =>
  jobGrant(x.ctx, {
    purpose: FINISH,
    job: 'pass-import',
    orgId: x.s.org.id,
    mode: 'live',
    inactiveOk: true,
    tables: ['pass_imports'],
    ...over,
  } as Parameters<typeof jobGrant>[1]);
const setOrg = (x: Awaited<ReturnType<typeof setupGrant>>, status: string) =>
  run(db, 'UPDATE orgs SET status = ? WHERE id = ?', [status, x.s.org.id]);

describe('inactiveOk job grants', () => {
  it('holds for an active and a suspended org, with the allowlisted purpose and tables', async () => {
    const x = await setupGrant('ina-ok');
    await expect(grantOf(x).commit()).resolves.toBeDefined();
    await setOrg(x, 'suspended');
    await expect(grantOf(x).commit()).resolves.toBeDefined();
  });

  it('is refused for a deleted org', async () => {
    const x = await setupGrant('ina-deleted');
    await setOrg(x, 'deleted');
    expect(await refusal(grantOf(x).commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });

  it('is refused on other tables and other purposes', async () => {
    const x = await setupGrant('ina-scope');
    expect(codeOf(() => grantOf(x, { tables: ['passes'] }))).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => grantOf(x, { tables: ['pass_imports', 'passes'] }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
    expect(codeOf(() => grantOf(x, { tables: undefined }))).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => grantOf(x, { purpose: 'org_mode.job.pass_import.progress' }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
  });

  it('without the flag a suspended org is refused', async () => {
    const x = await setupGrant('ina-flag');
    await setOrg(x, 'suspended');
    expect(await refusal(grantOf(x, { inactiveOk: undefined }).commit())).toMatchObject({
      code: 'ORG_ACCESS_CHANGED',
    });
  });
});
