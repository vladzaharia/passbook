// A provider claim is not ownership of an address: only a mailbox proof (or, with oidc.trustEmail
// on, a provider that verified it) is. Covers both orders of the pre-account takeover.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { signInOidc } from './oidc-sign-in.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { isOwnedByOther, primaryEmailOf } from './repo-magic.ts';
import { linkIdentityByMail, signInMagicLink, verifyEmailForUser } from './service.ts';
import { oidcSignIn } from './test-oidc.ts';
import {
  absorb,
  harness,
  ISSUER,
  type Jar,
  type TestHarness,
  waitingPass,
} from './test-support.ts';

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

  it('refuses the attacker-bound proof from another browser, and the owner still gets their own account', async () => {
    const victim = `victim-${uniq()}@example.test`;
    const pass = await waitingPass(victim);
    const attacker = person(victim);
    await oidcSignIn(h, new Map(), attacker);
    // The mail reaches the victim; opened in the victim's browser it is not the attacker's.
    expect((await consumeProof(new Map())).status).toBe(400);
    expect(
      await first(h.env.DB, 'SELECT 1 FROM users WHERE primary_email = ?', [victim]),
    ).toBeNull();
    expect(
      await first(h.env.DB, 'SELECT 1 FROM auth_identities WHERE subject = ?', [attacker.sub]),
    ).toBeNull();
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
    const subject = `proof-${uniq()}`;
    await linkIdentityByMail(
      ctx(),
      owner.primaryEmail,
      {
        provider: 'pocketid',
        subject,
        emailClaim: owner.primaryEmail,
        emailVerified: true,
        groups: ['wallet-users'],
      },
      sign,
    );
    const linked = await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM auth_identities WHERE subject = ?',
      [subject],
    );
    expect(linked?.user_id).toBe(owner.id);
    expect(linked?.user_id).not.toBe(attacker.user.id);
  });

  it('after the proof the browser goes back through Pocket ID and signs in with group roles', async () => {
    const email = `admin-${uniq()}@example.test`;
    const jar: Jar = new Map();
    const admin = { ...person(email), groups: ['wallet-admins'] };
    expect((await oidcSignIn(h, jar, admin)).res.status).toBe(403);
    const consumed = await consumeProof(jar);
    expect(consumed.status).toBe(303);
    expect(consumed.headers.get('location')).toBe('/auth/oidc/start');
    absorb(jar, consumed);
    expect(jar.has('__Host-wallet_sid')).toBe(false);
    const again = await oidcSignIn(h, jar, admin);
    expect(again.res.status).toBe(302);
    absorb(jar, again.res);
    const body = (await (await h.call('/api/v1/session', { cookies: jar })).json()) as {
      roles: string[];
      user: { primaryEmail: string };
    };
    expect(body.roles).toEqual(['admin', 'user', 'developer', 'console']);
    expect(body.user.primaryEmail).toBe(email);
  });

  it('carries the requested next through the proof', async () => {
    const jar: Jar = new Map();
    const holder = person(`next-${uniq()}@example.test`);
    expect((await oidcSignIn(h, jar, holder, { next: '/passes' })).res.status).toBe(403);
    const consumed = await consumeProof(jar);
    expect(consumed.headers.get('location')).toBe('/auth/oidc/start?next=%2Fpasses');
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

const usersCount = async () =>
  (await first<{ n: number }>(h.env.DB, 'SELECT count(*) AS n FROM users'))?.n ?? 0;
const unprovenAudits = async (id: string) =>
  (
    await all<{ id: string }>(
      h.env.DB,
      "SELECT id FROM audit_log WHERE action = 'auth.primary_email_unproven' AND target_id = ?",
      [id],
    )
  ).length;

describe('legacy accounts: claimants that are real people', () => {
  it('the claimant signed in on the proving browser gets the address on its own account', async () => {
    const email = `mine-${uniq()}@example.test`;
    const pass = await waitingPass(email);
    const claimant = await legacyClaimant(email);
    const before = await usersCount();
    const session = await signInMagicLink(ctx(), email, {
      ...sign,
      sessionUserId: claimant.user.id,
      sessionAmr: 'oidc',
    });
    expect(session.userId).toBe(claimant.user.id);
    expect(await usersCount()).toBe(before);
    expect(await verifiedRows(email)).toEqual([{ user_id: claimant.user.id }]);
    expect(await primaryOf(claimant.user.id)).toBe(email);
    expect(await ownerOf(pass.id)).toBe(claimant.user.id);
    expect(await unprovenAudits(claimant.user.id)).toBe(0);
  });

  it('a mail-link session for the claimant does not keep the address (login CSRF)', async () => {
    const email = `csrf-${uniq()}@example.test`;
    const pass = await waitingPass(email);
    const claimant = await legacyClaimant(email);
    // The attacker plants its own mail-link session in the victim's browser, then the victim
    // follows the link mailed to the victim's address.
    const f = fixtures(h.env, h.clock);
    const planted = await makeSession(f, { userId: claimant.user.id, amr: 'magic_link' });
    const jar: Jar = new Map([['__Host-wallet_sid', planted.cookieValue]]);
    const requested = await h.call('/auth/magic/request', {
      method: 'POST',
      json: { email, turnstileToken: 'ok' },
    });
    expect(requested.status).toBe(202);
    const token = /t=([\w-]+)/.exec(h.mail.at(-1)?.text ?? '')?.[1] ?? '';
    const res = await h.call('/auth/magic/consume', {
      method: 'POST',
      body: new URLSearchParams({ token }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: jar,
    });
    expect(res.status).toBe(303);
    expect(await verifiedRows(email)).toHaveLength(1);
    expect((await verifiedRows(email))[0]?.user_id).not.toBe(claimant.user.id);
    expect(await ownerOf(pass.id)).not.toBe(claimant.user.id);
    expect(await unprovenAudits(claimant.user.id)).toBe(1);
  });

  it('a Pocket ID session whose claim names another address does not keep this one', async () => {
    const email = `claim-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    await run(
      h.env.DB,
      "UPDATE auth_identities SET email_claim = 'else@example.test' WHERE user_id = ?",
      [claimant.user.id],
    );
    const session = await signInMagicLink(ctx(), email, {
      ...sign,
      sessionUserId: claimant.user.id,
      sessionAmr: 'oidc',
    });
    expect(session.userId).not.toBe(claimant.user.id);
    expect(await unprovenAudits(claimant.user.id)).toBe(1);
  });

  it('a different signed-in account does not count as the claimant', async () => {
    const email = `mine-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    const other = await makeUser(fixtures(h.env));
    const session = await signInMagicLink(ctx(), email, { ...sign, sessionUserId: other.id });
    expect(session.userId).not.toBe(claimant.user.id);
    expect(session.userId).not.toBe(other.id);
  });

  it('a disabled claimant is refused, not replaced by a fresh account', async () => {
    const email = `gone-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [claimant.user.id]);
    const before = await usersCount();
    await expect(signInMagicLink(ctx(), email, sign)).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
    });
    expect(await usersCount()).toBe(before);
    expect(await primaryOf(claimant.user.id)).toBe(email);
    expect(await verifiedRows(email)).toEqual([]);
    expect(await unprovenAudits(claimant.user.id)).toBe(0);
    await setTrust(true);
    await expect(
      signInOidc(ctx(), { ...person(email), emailVerified: true }, sign),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });

  it('a backfilled claimant signs in by magic link without splitting', async () => {
    const email = `staff-${uniq()}@example.test`;
    const pass = await waitingPass(email);
    const claimant = await legacyClaimant(email);
    await run(
      h.env.DB,
      "INSERT OR IGNORE INTO user_emails (email, user_id, verified_via, verified_at) SELECT primary_email, id, 'admin', 1 FROM users WHERE id IN (?)",
      [claimant.user.id],
    );
    const before = await usersCount();
    const session = await signInMagicLink(ctx(), email, sign);
    expect(session.userId).toBe(claimant.user.id);
    expect(await usersCount()).toBe(before);
    expect(await primaryOf(claimant.user.id)).toBe(email);
    expect(await unprovenAudits(claimant.user.id)).toBe(0);
    expect(await ownerOf(pass.id)).toBe(claimant.user.id);
  });
});

describe('releasing a claim', () => {
  it('two proofs racing release it once and make one account', async () => {
    const email = `race-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    const before = await usersCount();
    const results = await Promise.allSettled([
      signInMagicLink(ctx(), email, sign),
      signInMagicLink(ctx(), email, sign),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(await unprovenAudits(claimant.user.id)).toBe(1);
    expect(await usersCount()).toBe(before + 1);
    const owners = await verifiedRows(email);
    expect(owners).toHaveLength(1);
    for (const r of results)
      if (r.status === 'fulfilled') expect(r.value.userId).toBe(owners[0]?.user_id);
  });

  it('verifying the address on another account releases the claim too', async () => {
    const email = `verify-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    const asker = await makeUser(fixtures(h.env));
    await verifyEmailForUser(ctx(), asker.id, email);
    expect(await verifiedRows(email)).toEqual([{ user_id: asker.id }]);
    expect(await primaryOf(claimant.user.id)).toBe(`${claimant.user.id}@unverified.invalid`);
    expect(await unprovenAudits(claimant.user.id)).toBe(1);
  });

  it('a trusted provider sign-in that adds the address releases the claim too', async () => {
    await setTrust(true);
    const email = `trusted-${uniq()}@example.test`;
    const holder = person(`first-${uniq()}@example.test`);
    expect((await oidcSignIn(h, new Map(), holder)).res.status).toBe(302);
    const claimant = await legacyClaimant(email);
    // The same subject comes back with a new verified address.
    expect((await oidcSignIn(h, new Map(), { ...holder, email })).res.status).toBe(302);
    const owner = await first<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM auth_identities WHERE subject = ?',
      [holder.sub],
    );
    expect(await verifiedRows(email)).toEqual([{ user_id: owner?.user_id }]);
    expect(await primaryOf(claimant.user.id)).toBe(`${claimant.user.id}@unverified.invalid`);
  });
});

describe('an account with no verified address', () => {
  it('shows as having none in the session and to admins, never the placeholder', async () => {
    const email = `ghost-${uniq()}@example.test`;
    const claimant = await legacyClaimant(email);
    await signInMagicLink(ctx(), email, sign);
    const f = fixtures(h.env, h.clock);
    const own = await makeSession(f, { userId: claimant.user.id });
    const session = (await (
      await h.call('/api/v1/session', {
        cookies: new Map([['__Host-wallet_sid', own.cookieValue]]),
      })
    ).json()) as {
      user: { primaryEmail: string | null };
    };
    expect(session.user.primaryEmail).toBeNull();
    const admin = await makeSession(f, {
      userId: (await makeUser(f)).id,
      roles: ['admin', 'user'],
    });
    const detail = (await (
      await h.call(`/api/v1/users/${claimant.user.id}`, { headers: admin.headers })
    ).json()) as { primaryEmail: string | null };
    expect(detail.primaryEmail).toBeNull();
    const mine = (await (await h.call('/api/v1/me/emails', { headers: own.headers })).json()) as {
      items: { email: string }[];
    };
    expect(JSON.stringify(mine)).not.toContain('unverified.invalid');
    expect(await primaryEmailOf(h.env.DB, claimant.user.id)).toBeNull();
  });
});

describe('identity links are audited once', () => {
  it('writes auth.identity_linked only when the subject was linked now', async () => {
    const owner = await makeUser(fixtures(h.env));
    const pending = {
      provider: 'pocketid',
      subject: `once-${uniq()}`,
      emailClaim: owner.primaryEmail,
      emailVerified: true,
      groups: ['wallet-users'],
    };
    await linkIdentityByMail(ctx(), owner.primaryEmail, pending, sign);
    await linkIdentityByMail(ctx(), owner.primaryEmail, pending, sign);
    const rows = await all(
      h.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'auth.identity_linked' AND target_id = ?",
      [owner.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('identity-proof mail is capped', () => {
  const binding = { ...sign, bindingHash: 'b'.repeat(64) };

  it('per Pocket ID subject, whatever the address', async () => {
    await setTrust(false);
    const subject = person(`s-${uniq()}@example.test`);
    for (let i = 0; i < 10; i++) {
      await expect(
        signInOidc(
          ctx(),
          { ...subject, email: `s${i}-${uniq()}@example.test`, emailVerified: true },
          binding,
        ),
      ).rejects.toMatchObject({ code: 'EMAIL_PROOF_SENT' });
    }
    const sent = h.mail.length;
    await expect(
      signInOidc(
        ctx(),
        { ...subject, email: `s-${uniq()}@example.test`, emailVerified: true },
        binding,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(h.mail).toHaveLength(sent);
  });

  it('per network, whatever the subject', async () => {
    await setTrust(false);
    const net = { ...binding, ipPrefix: '198.51.100.0/24' };
    for (let i = 0; i < 30; i++) {
      await expect(
        signInOidc(ctx(), { ...person(`n${i}-${uniq()}@example.test`), emailVerified: true }, net),
      ).rejects.toMatchObject({ code: 'EMAIL_PROOF_SENT' });
    }
    const sent = h.mail.length;
    await expect(
      signInOidc(ctx(), { ...person(`n-${uniq()}@example.test`), emailVerified: true }, net),
    ).rejects.toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(h.mail).toHaveLength(sent);
  });
});
