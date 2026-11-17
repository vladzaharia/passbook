// A provider claim is not ownership of an address: only a mailbox proof (or, with oidc.trustEmail
// on, a provider that verified it) is. Covers both orders of the pre-account takeover.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { signInOidc } from './oidc-sign-in.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { isOwnedByOther } from './repo-magic.ts';
import { signInMagicLink, verifyEmailForUser } from './service.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type Jar, type TestHarness, waitingPass } from './test-support.ts';

let h: TestHarness;
let n = 0;
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;
const sign = { ipPrefix: null, userAgent: null };
const ctx = () => createServiceContext(h.env, { clock: h.clock });
const person = (email: string) => ({
  sub: `sub-${uniq()}`,
  email,
  name: 'Person',
  groups: ['wallet-users'],
});

const setTrust = (on: boolean | null) => setOidcTrust(h.env.DB, on);

/** An account made the way trust-off sign-in used to: the claim as primary email, no proof. */
async function legacyClaimant(email: string) {
  const user = await makeUser(fixtures(h.env), { primaryEmail: email, verified: false });
  const subject = `legacy-${uniq()}`;
  await run(
    h.env.DB,
    `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
     VALUES ('pocketid', ?, ?, ?, 1, '[]', 1)`,
    [subject, user.id, email],
  );
  return { user, subject };
}

const ownerOf = async (passId: string) =>
  (
    await first<{ owner_user_id: string | null }>(
      h.env.DB,
      'SELECT owner_user_id FROM passes WHERE id = ?',
      [passId],
    )
  )?.owner_user_id ?? null;
const primaryOf = async (id: string) =>
  (
    await first<{ primary_email: string }>(
      h.env.DB,
      'SELECT primary_email FROM users WHERE id = ?',
      [id],
    )
  )?.primary_email;
const verifiedRows = (email: string) =>
  all<{ user_id: string }>(h.env.DB, 'SELECT user_id FROM user_emails WHERE email = ?', [email]);

async function consumeProof(jar: Jar) {
  const token = /t=([\w-]+)/.exec(h.mail.at(-1)?.text ?? '')?.[1] ?? '';
  return h.call('/auth/magic/consume', {
    method: 'POST',
    body: new URLSearchParams({ token }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookies: jar,
  });
}

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
});
afterEach(async () => {
  h.restore();
  await setTrust(null);
});

describe('trust off: the attacker signs in with the victim address first', () => {
  it('creates no account and links nothing from the claim', async () => {
    const victim = `victim-${uniq()}@example.test`;
    const attacker = person(victim);
    const { res } = await oidcSignIn(h, new Map(), attacker);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Check your email');
    expect(
      await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [victim]),
    ).toBeNull();
    expect(
      await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [attacker.sub]),
    ).toBeNull();
  });

  it('keeps the victim and the attacker on different accounts', async () => {
    const victim = `victim-${uniq()}@example.test`;
    const pass = await waitingPass(victim);
    await oidcSignIn(h, new Map(), person(victim));
    const session = await signInMagicLink(ctx(), victim, sign);
    expect(await ownerOf(pass.id)).toBe(session.userId);
    expect(await verifiedRows(victim)).toEqual([{ user_id: session.userId }]);
  });
});

describe('an account made earlier from an unverified claim', () => {
  it('is not joined by the holder who later proves the address by mail', async () => {
    const victim = `victim-${uniq()}@example.test`;
    const pass = await waitingPass(victim);
    const attacker = await legacyClaimant(victim);
    const session = await signInMagicLink(ctx(), victim, sign);
    expect(session.userId).not.toBe(attacker.user.id);
    expect(await ownerOf(pass.id)).toBe(session.userId);
    expect(await verifiedRows(victim)).toEqual([{ user_id: session.userId }]);
    expect(await primaryOf(session.userId)).toBe(victim);
    // The claimant keeps its sign-in, loses the address, and does not gain the pass.
    expect(await primaryOf(attacker.user.id)).toBe(`${attacker.user.id}@unverified.invalid`);
    expect(
      await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ? AND user_id = ?', [
        attacker.subject,
        attacker.user.id,
      ]),
    ).not.toBeNull();
    const audit = await all<{ target_id: string; detail: string | null }>(
      h.env.DB,
      "SELECT target_id, detail FROM audit_log WHERE action = 'auth.primary_email_unproven'",
    );
    expect(audit.map((a) => a.target_id)).toContain(attacker.user.id);
    expect(JSON.stringify(audit)).not.toContain(victim);
  });

  it('does not take the holder who proves the address through their own provider subject', async () => {
    const victim = `victim-${uniq()}@example.test`;
    const attacker = await legacyClaimant(victim);
    const jar: Jar = new Map();
    const holder = person(victim);
    const { res } = await oidcSignIn(h, jar, holder);
    expect(res.status).toBe(403);
    expect(h.mail.at(-1)?.to).toBe(victim);
    expect((await consumeProof(jar)).status).toBe(303);
    const linked = await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM auth_identities WHERE subject = ?',
      [holder.sub],
    );
    expect(linked?.user_id).toBeDefined();
    expect(linked?.user_id).not.toBe(attacker.user.id);
    expect(await verifiedRows(victim)).toEqual([{ user_id: linked?.user_id }]);
  });

  it('is not joined by a provider that vouches for the address (trust on)', async () => {
    await setTrust(true);
    const victim = `victim-${uniq()}@example.test`;
    const attacker = await legacyClaimant(victim);
    const holder = person(victim);
    const { res } = await oidcSignIn(h, new Map(), holder);
    expect(res.status).toBe(302);
    const linked = await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM auth_identities WHERE subject = ?',
      [holder.sub],
    );
    expect(linked?.user_id).not.toBe(attacker.user.id);
    expect(await verifiedRows(victim)).toEqual([{ user_id: linked?.user_id }]);
  });

  it('can still verify its own address by mail like anyone else', async () => {
    const attacker = await legacyClaimant(`claim-${uniq()}@example.test`);
    const mine = `mine-${uniq()}@example.test`;
    await verifyEmailForUser(ctx(), attacker.user.id, mine);
    expect(await verifiedRows(mine)).toEqual([{ user_id: attacker.user.id }]);
  });
});

describe('positive controls', () => {
  it('trust on: a verified claim creates the account with that address proven', async () => {
    await setTrust(true);
    const email = `new-${uniq()}@example.test`;
    const { res } = await oidcSignIn(h, new Map(), person(email));
    expect(res.status).toBe(302);
    const user = await first<{ id: string; primary_email: string }>(
      h.env.DB,
      'SELECT id, primary_email FROM users WHERE primary_email = ?',
      [email],
    );
    expect(await verifiedRows(email)).toEqual([{ user_id: user?.id }]);
  });

  it('a proven address still signs into its owner, with its identity', async () => {
    const owner = await makeUser(fixtures(h.env));
    const attacker = await legacyClaimant(`other-${uniq()}@example.test`);
    const session = await signInMagicLink(ctx(), owner.primaryEmail, sign, {
      provider: 'pocketid',
      subject: `proof-${uniq()}`,
      emailClaim: owner.primaryEmail,
      emailVerified: true,
      groups: ['wallet-users'],
    });
    expect(session.userId).toBe(owner.id);
    expect(session.userId).not.toBe(attacker.user.id);
  });

  it('an account without a provider identity still owns its primary email', async () => {
    const email = `admin-made-${uniq()}@example.test`;
    const user = await makeUser(fixtures(h.env), { primaryEmail: email, verified: false });
    expect((await signInMagicLink(ctx(), email, sign)).userId).toBe(user.id);
  });

  it('a placeholder primary becomes the first address the account proves', async () => {
    const email = `claim-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    await signInMagicLink(ctx(), email, sign);
    const mine = `mine-${uniq()}@example.test`;
    await verifyEmailForUser(ctx(), claimant.user.id, mine);
    expect(await primaryOf(claimant.user.id)).toBe(mine);
  });
});

describe('isOwnedByOther', () => {
  it('ignores a primary email held through a provider identity, honours the rest', async () => {
    const asker = await makeUser(fixtures(h.env));
    const claim = `claim-${uniq()}@example.test`;
    await legacyClaimant(claim);
    expect(await isOwnedByOther(h.env.DB, claim, asker.id)).toBe(false);
    const plain = await makeUser(fixtures(h.env), { verified: false });
    expect(await isOwnedByOther(h.env.DB, plain.primaryEmail, asker.id)).toBe(true);
    const verified = await makeUser(fixtures(h.env));
    expect(await isOwnedByOther(h.env.DB, verified.primaryEmail, asker.id)).toBe(true);
  });
});

describe('signInOidc directly', () => {
  it('refuses a disabled owner before sending proof', async () => {
    const owner = await makeUser(fixtures(h.env));
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [owner.id]);
    await expect(
      signInOidc(
        ctx(),
        { ...person(owner.primaryEmail), emailVerified: true },
        {
          ...sign,
          bindingHash: 'b'.repeat(64),
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(h.mail).toHaveLength(0);
  });
});
