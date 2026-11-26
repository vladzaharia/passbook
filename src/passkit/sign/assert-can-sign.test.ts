import { describe, expect, it } from 'vitest';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import { assertCanSign } from './index.ts';

describe('assertCanSign', () => {
  it('passes a certificate its own intermediate issued, as signing would', async () => {
    const own = await createFixtureIdentity();
    await expect(assertCanSign(own)).resolves.toBeDefined();
  });

  it('refuses a certificate from another CA with SIGN_CHAIN_INVALID', async () => {
    const own = await createFixtureIdentity();
    const other = await createFixtureIdentity();
    const error = await assertCanSign({
      certificate: other.certificate,
      intermediate: own.intermediate,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SIGN_CHAIN_INVALID' });
  });

  it('refuses a certificate that is out of date, and one for another identity', async () => {
    const own = await createFixtureIdentity();
    const later = new Date(Date.now() + 30 * 86_400_000);
    expect(await assertCanSign(own, { now: later }).catch((e: unknown) => e)).toMatchObject({
      code: 'SIGN_CERT_NOT_VALID',
    });
    const mismatch = await assertCanSign(own, {
      expectedIdentity: { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.other' },
    }).catch((e: unknown) => e);
    expect(mismatch).toMatchObject({ code: 'SIGN_IDENTITY_MISMATCH' });
  });
});
