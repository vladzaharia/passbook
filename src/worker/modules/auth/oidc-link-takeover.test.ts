// An email session can add an address to its account. A fresh Polaris ID subject carrying that
// address must not land on that account: only the account's own primary email links.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { maskEmail } from '../../../shared/email.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { makeMyEmailPrimary } from '../me/service-account.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { adoptPrimaryEmail, unverifiedPrimaryEmail } from './repo.ts';
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

const refusedFor = async (trust: boolean, email: string) => {
  await setOidcTrust(h.env.DB, trust);
  const subject = { sub: `sub-${uniq()}`, email, name: 'Someone', groups: ['wallet_users'] };
  const { res } = await oidcSignIn(h, new Map(), subject);
  return { res, subject };
};
const noTrace = async (subject: string, email: string) => {
  expect(await linkedUser(subject)).toBeNull();
  expect(await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [email])).toBeNull();
};

describe('Polaris ID email that is only a secondary address', () => {
  it('trust on: refused with IDP_EMAIL_NOT_PRIMARY, nothing created or bound', async () => {
    const { victim, added } = await victimWithAddedAddress();
    const { res, subject } = await refusedFor(true, added);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Wrong email');
    expect(html).toContain(maskEmail(victim.primaryEmail));
    await noTrace(subject.sub, added);
    const audit = await first(
      h.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'auth.oidc_email_not_primary' AND target_id = ?",
      [victim.id],
    );
    expect(audit).not.toBeNull();
  });

  // Before: the page named the masked primary for an unproven claim. Now an unproven claim learns
  // nothing about the account; the mask comes only after the address proves itself by mail.
  it('trust off: an unproven claim gets the mail proof, not the masked primary', async () => {
    const { victim, added } = await victimWithAddedAddress();
    const { res, subject } = await refusedFor(false, added);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Check your email');
    expect(html).not.toContain(maskEmail(victim.primaryEmail));
    expect(h.mail.at(-1)?.to).toBe(added);
    await noTrace(subject.sub, added);
  });

  it('the mail-proof link path refuses too', async () => {
    const { added } = await victimWithAddedAddress();
    const subject = `sub-${uniq()}`;
    await expect(
      linkIdentityByMail(
        ctx(),
        added,
        {
          provider: 'pocketid',
          subject,
          emailClaim: added,
          emailVerified: true,
          groups: ['wallet_users'],
        },
        sign,
      ),
    ).rejects.toMatchObject({ code: 'IDP_EMAIL_NOT_PRIMARY' });
    await noTrace(subject, added);
  });

  it('a member whose primary an email session moved is not linked by it', async () => {
    const victim = await makeUser(fixtures(h.env));
    const org = await makeOrg(fixtures(h.env));
    await grantScanMembership(fixtures(h.env), org.id, victim.id, ['pass_operator']);
    await run(h.env.DB, "UPDATE users SET primary_set_amr = 'magic_link' WHERE id = ?", [
      victim.id,
    ]);
    const { res, subject } = await refusedFor(true, victim.primaryEmail);
    expect(res.status).toBe(403);
    expect(await linkedUser(subject.sub)).toBeNull();
  });

  it('adopting a primary from an email session is refused for a member', async () => {
    const victim = await makeUser(fixtures(h.env));
    const org = await makeOrg(fixtures(h.env));
    await grantScanMembership(fixtures(h.env), org.id, victim.id, ['pass_operator']);
    const placeholder = unverifiedPrimaryEmail(victim.id);
    await run(h.env.DB, 'UPDATE users SET primary_email = ? WHERE id = ?', [
      placeholder,
      victim.id,
    ]);
    await adoptPrimaryEmail(h.env.DB, victim.id, `new-${uniq()}@example.test`, 'magic_link');
    const row = await first<{ primary_email: string }>(
      h.env.DB,
      'SELECT primary_email FROM users WHERE id = ?',
      [victim.id],
    );
    expect(row?.primary_email).toBe(placeholder);
  });

  it('matches the primary email case-insensitively', async () => {
    const victim = await makeUser(fixtures(h.env));
    await run(h.env.DB, 'UPDATE users SET primary_email = ? WHERE id = ?', [
      victim.primaryEmail.toUpperCase(),
      victim.id,
    ]);
    await setOidcTrust(h.env.DB, true);
    const person = {
      sub: `sub-${uniq()}`,
      email: victim.primaryEmail,
      name: 'V',
      groups: ['wallet_users'],
    };
    await oidcSignIn(h, new Map(), person);
    expect(await linkedUser(person.sub)).toBe(victim.id);
  });

  it('still links by the primary email the account signed up with', async () => {
    const victim = await makeUser(fixtures(h.env));
    await setOidcTrust(h.env.DB, true);
    const person = {
      sub: `sub-${uniq()}`,
      email: victim.primaryEmail,
      name: 'Victim',
      groups: ['wallet_users'],
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
