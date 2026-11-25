import { describe, expect, it } from 'vitest';
import { stmt } from '../../platform/db.ts';
import { accountCheckFailing } from './repo-account-health.ts';
import {
  CHECK_JOB,
  credential,
  db,
  granted,
  seedOrg,
  uid,
} from './repo-wallet-credentials-test-fixtures.ts';
import { enrolment, setSource } from './repo-wallet-enrolments-test-fixtures.ts';

// A check's time is the server's, so two checks need a millisecond between them.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

async function account() {
  const { org } = await seedOrg();
  const cred = await credential({ orgId: org.id });
  const acct = await enrolment(org.id);
  await setSource(acct, cred);
  const check = async (ok: 0 | 1, code: string | null) => {
    await later();
    await granted(CHECK_JOB, [
      stmt(
        db(),
        'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok, code) VALUES (?, ?, ?, ?, ?)',
        [uid(), cred.id, cred.versionId, ok, code],
      ),
    ]);
  };
  return { acct, check };
}

/** Q6: an account whose credentials last failed twice in a row shows no wallet badge. */
describe('account health from the credential check', () => {
  it('is failing only on two definitive failures in a row, and a pass clears it', async () => {
    const { acct, check } = await account();
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
    await check(0, 'auth_failed');
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
    await check(0, 'issuer_not_found');
    expect(await accountCheckFailing(db(), acct.id)).toBe(true);
    await check(1, null);
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
  });

  it('is not failing on a transient failure, however many: a timeout says nothing about the credentials', async () => {
    const { acct, check } = await account();
    await check(0, 'unreachable');
    await check(0, 'provider_error');
    await check(0, 'unreachable');
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
    // A transient failure in between breaks the run of definitive ones.
    await check(0, 'auth_failed');
    await check(0, 'unreachable');
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
  });

  it('is not failing without a source credential or a check', async () => {
    const { org } = await seedOrg();
    const acct = await enrolment(org.id);
    expect(await accountCheckFailing(db(), acct.id)).toBe(false);
  });
});
