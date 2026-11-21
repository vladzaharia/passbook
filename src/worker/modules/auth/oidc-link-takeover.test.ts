// An email session can add an address to its account. A fresh Polaris ID subject carrying that
// address must not land on that account: only the account's own primary email links.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { makeMyEmailPrimary } from '../me/service-account.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { linkIdentityByMail, verifyEmailForUser } from './service.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
const ctx = () => createServiceContext(h.env, { clock: h.clock });
const sign = { ipPrefix: null, userAgent: null };
const linkedUser = async (subject: string) =>
  (
    await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM auth_identities WHERE subject = ?',
      [subject],
    )
  )?.user_id ?? null;

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
});
afterEach(async () => {
  h.restore();
  await setOidcTrust(h.env.DB, null);
});

async function victimWithAddedAddress() {
  const victim = await makeUser(fixtures(h.env));
  const org = await makeOrg(fixtures(h.env));
  await grantScanMembership(fixtures(h.env), org.id, victim.id, ['pass_operator']);
  const added = `added-${uniq()}@example.test`;
  // What an email-link session of the victim can do through /me.
  await verifyEmailForUser(ctx(), victim.id, added);
  return { victim, added };
}

describe('Polaris ID link by an address added through an email session', () => {
  it('trust on: a fresh subject with that address gets its own account, not the victim', async () => {
    const { victim, added } = await victimWithAddedAddress();
    await setOidcTrust(h.env.DB, true);
    const attacker = {
      sub: `sub-${uniq()}`,
      email: added,
      name: 'Attacker',
      groups: ['wallet-users'],
    };
    await oidcSignIn(h, new Map(), attacker);
    const owner = await linkedUser(attacker.sub);
    expect(owner).not.toBe(victim.id);
  });

  it('trust off: the mailed proof does not link the subject to the victim either', async () => {
    const { victim, added } = await victimWithAddedAddress();
    const subject = `sub-${uniq()}`;
    await linkIdentityByMail(
      ctx(),
      added,
      {
        provider: 'pocketid',
        subject,
        emailClaim: added,
        emailVerified: true,
        groups: ['wallet-users'],
      },
      sign,
    ).catch(() => undefined);
    expect(await linkedUser(subject)).not.toBe(victim.id);
  });

  it('still links by the primary email the account signed up with', async () => {
    const victim = await makeUser(fixtures(h.env));
    await setOidcTrust(h.env.DB, true);
    const person = {
      sub: `sub-${uniq()}`,
      email: victim.primaryEmail,
      name: 'Victim',
      groups: ['wallet-users'],
    };
    await oidcSignIn(h, new Map(), person);
    expect(await linkedUser(person.sub)).toBe(victim.id);
  });

  it('an email session of a member cannot make the added address primary, a Polaris ID one can', async () => {
    const { victim, added } = await victimWithAddedAddress();
    await expect(makeMyEmailPrimary(ctx(), victim.id, added, 'magic_link')).rejects.toMatchObject({
      code: 'IDP_SIGN_IN_REQUIRED',
    });
    await makeMyEmailPrimary(ctx(), victim.id, added, 'oidc');
  });
});
