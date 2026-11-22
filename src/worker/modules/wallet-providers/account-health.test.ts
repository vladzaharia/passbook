import { describe, expect, it } from 'vitest';
import { accountCheckFailing } from './repo-account-health.ts';
import { addCheck, credential, db, seedOrg } from './repo-wallet-credentials-test-fixtures.ts';
import { enrolment, setSource } from './repo-wallet-enrolments-test-fixtures.ts';

// A check's time is the server's, so two checks need a millisecond between them.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Q6: an account whose credential last failed its check shows no wallet badge. */
describe('account health from the credential check', () => {
  it('is failing only when the newest check failed, and a later pass clears it', async () => {
    const { org } = await seedOrg();
    const cred = await credential({ orgId: org.id });
    const account = await enrolment(org.id);
    await setSource(account, cred);
    expect(await accountCheckFailing(db(), account.id)).toBe(false);
    await addCheck(cred.id, cred.versionId, 1);
    expect(await accountCheckFailing(db(), account.id)).toBe(false);
    await later();
    await addCheck(cred.id, cred.versionId, 0);
    expect(await accountCheckFailing(db(), account.id)).toBe(true);
    await later();
    await addCheck(cred.id, cred.versionId, 1);
    expect(await accountCheckFailing(db(), account.id)).toBe(false);
  });

  it('is not failing without a source credential or a check', async () => {
    const { org } = await seedOrg();
    const account = await enrolment(org.id);
    expect(await accountCheckFailing(db(), account.id)).toBe(false);
  });
});
