// A rotation appends a version of the same credential: enrolments keep their id, source, state and HMAC key,
// and runtime resolves the new version for new work and the pinned one for old work.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { randomBytes, toBase64Url } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import type { StoredCredentials } from './account-credential-material.ts';
import { applyEnrolmentSource, historicalSources } from './account-credential-source.ts';
import {
  addRealVersion,
  googleSecret,
  realCredential,
} from './account-credential-test-fixtures.ts';
import { db, refused, seedOrg } from './repo-wallet-credentials-test-fixtures.ts';
import { enrolment, setSource } from './repo-wallet-enrolments-test-fixtures.ts';

const ctx = () => createServiceContext(env);
const hmac = toBase64Url(randomBytes(32));

async function legacy(): Promise<Extract<StoredCredentials, { provider: 'google' }>> {
  const secret = await googleSecret('1000000000000001');
  if (secret.provider !== 'google') throw new Error('unreachable');
  return { version: 1, provider: 'google', credentials: secret.credentials, objectIdHmacKey: hmac };
}

const state = (id: string) =>
  first(
    db(),
    'SELECT id, credential_source_id, identity_hash, enabled_at, enrolment_revision, revoked_at FROM wallet_provider_accounts WHERE id = ?',
    [id],
  );

describe('rotation', () => {
  it('keeps the enrolment and its HMAC key; new work uses the new version, pinned work the old one', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    const first1 = await googleSecret('2000000000000001');
    const c = await realCredential(env, { orgId: org.id }, first1);
    await setSource(a, c);
    const before = await state(a.id);
    const owner = { id: a.id, orgId: a.orgId, mode: a.mode, provider: a.provider };
    const stored = await legacy();
    const read = (pin: Parameters<typeof applyEnrolmentSource>[3]) =>
      applyEnrolmentSource(ctx(), owner, stored, pin);

    const v1 = await read({ current: true, activeOnly: true });
    expect(v1).toMatchObject({ objectIdHmacKey: hmac, credentials: first1.credentials });

    const second = await googleSecret('2000000000000001');
    const v2Id = await addRealVersion(env, c, second);
    // The enrolment row is untouched: same id, source, identity, state and revision.
    expect(await state(a.id)).toEqual(before);
    const v2 = await read({ current: true, activeOnly: true });
    expect(v2).toMatchObject({ objectIdHmacKey: hmac, credentials: second.credentials });
    expect(v2).not.toMatchObject({ credentials: first1.credentials });
    // Old work stays on the version it was made under; the pin names the later one for new work.
    expect(await read({ versionId: c.currentId })).toMatchObject({
      credentials: first1.credentials,
    });
    expect(await read({ versionId: v2Id })).toMatchObject({ credentials: second.credentials });
    // A NULL pin is legacy: the envelope as it was.
    expect(await read({ versionId: null })).toBe(stored);
    const chain = await historicalSources(ctx(), owner, stored, c.currentId);
    expect(chain.map((x) => (x.provider === 'google' ? x.credentials.privateKeyPem : ''))).toEqual([
      first1.provider === 'google' ? first1.credentials.privateKeyPem : '',
      second.provider === 'google' ? second.credentials.privateKeyPem : '',
    ]);
  });

  it('refuses a version whose secret carries another identity than its rows', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    const own = await googleSecret('3000000000000001');
    const c = await realCredential(env, { orgId: org.id }, own);
    await setSource(a, c);
    // The rows claim identity 3000...01 (the DB checks only the rows); the secret says another issuer.
    await addRealVersion(env, c, await googleSecret('3000000000000002'));
    await refused(
      applyEnrolmentSource(
        ctx(),
        { id: a.id, orgId: a.orgId, mode: a.mode, provider: a.provider },
        await legacy(),
        { current: true, activeOnly: true },
      ),
      /unavailable/i,
    );
  });
});
