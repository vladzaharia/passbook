import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { maskEmail } from '../../../shared/email.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { resetOidcClientCaches } from './oidc-client.ts';
import { setOidcTrust } from './oidc-trust-test-fixtures.ts';
import { verifyEmailForUser } from './service.ts';
import { oidcSignIn } from './test-oidc.ts';
import { harness, ISSUER, type Jar, type TestHarness } from './test-support.ts';

let h: TestHarness;
let n = 0;
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(async () => {
  await resetOidcClientCaches(ISSUER);
  h = await harness();
});
afterEach(async () => {
  h.restore();
  await setOidcTrust(h.env.DB, null);
});

/** A member whose primary an email session moved, with no Polaris ID yet. */
async function stuckMember() {
  const member = await makeUser(fixtures(h.env));
  const org = await makeOrg(fixtures(h.env));
  await grantScanMembership(fixtures(h.env), org.id, member.id, ['pass_operator']);
  await run(h.env.DB, "UPDATE users SET primary_set_amr = 'magic_link' WHERE id = ?", [member.id]);
  return member;
}

const person = (email: string) => ({
  sub: `sub-${uniq()}`,
  email,
  name: 'Someone',
  groups: ['wallet_users'],
});
const identityOf = (sub: string) =>
  first<{ user_id: string }>(h.env.DB, 'SELECT user_id FROM auth_identities WHERE subject = ?', [
    sub,
  ]);
const consume = (mailText: string, cookies: Jar) =>
  h.call('/auth/magic/consume', {
    method: 'POST',
    body: new URLSearchParams({ token: /t=([\w-]+)/.exec(mailText)?.[1] ?? '' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookies,
  });

describe.each([true, false])('member whose primary an email session moved (trust %s)', (trust) => {
  beforeEach(() => setOidcTrust(h.env.DB, trust));

  it('links Polaris ID only after mail proof to the primary, from the same browser', async () => {
    const member = await stuckMember();
    const user = person(member.primaryEmail);
    const jar: Jar = new Map();
    const { res } = await oidcSignIn(h, jar, user);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Check your email');
    expect(h.mail.at(-1)?.to).toBe(member.primaryEmail);
    expect(await identityOf(user.sub)).toBeNull();
    const text = h.mail.at(-1)?.text ?? '';
    // The inbox alone, from another browser, links nothing.
    expect((await consume(text, new Map())).status).toBe(400);
    expect(await identityOf(user.sub)).toBeNull();
    const done = await consume(text, jar);
    expect(done.status).toBe(303);
    expect((await identityOf(user.sub))?.user_id).toBe(member.id);
    const audit = await all(
      h.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'auth.identity_linked_moved_primary' AND target_id = ?",
      [member.id],
    );
    expect(audit).toHaveLength(1);
    // The link is single use.
    expect((await consume(text, jar)).status).toBe(400);
  });

  it('an account that already has a Polaris ID is not opened to a second subject', async () => {
    const member = await stuckMember();
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at, last_used_at)
       VALUES ('pocketid', ?, ?, NULL, 0, '[]', 0, 0)`,
      [`old-${uniq()}`, member.id],
    );
    const user = person(member.primaryEmail);
    const jar: Jar = new Map();
    const { res } = await oidcSignIn(h, jar, user);
    expect(res.status).toBe(403);
    if (!trust) expect((await consume(h.mail.at(-1)?.text ?? '', jar)).status).toBe(403);
    expect(await identityOf(user.sub)).toBeNull();
  });
});

const codeConsume = (email: string, code: string, cookies: Jar) =>
  h.call('/auth/magic/consume', { method: 'POST', json: { email, code }, cookies });
const identityCount = async (userId: string) =>
  (await all(h.env.DB, 'SELECT 1 FROM auth_identities WHERE user_id = ?', [userId])).length;

describe.each([true, false])(
  'the lift needs the invited address and no identity (trust %s)',
  (trust) => {
    beforeEach(() => setOidcTrust(h.env.DB, trust));

    it('a primary moved to an address other than the invitation is refused after proof', async () => {
      const member = await stuckMember();
      const moved = `moved-${uniq()}@example.test`;
      await run(
        h.env.DB,
        'INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, ?, 0)',
        [moved, member.id, 'magic_link'],
      );
      await run(h.env.DB, 'UPDATE users SET primary_email = ? WHERE id = ?', [moved, member.id]);
      const user = person(moved);
      const jar: Jar = new Map();
      const { res } = await oidcSignIn(h, jar, user);
      expect(res.status).toBe(403);
      if (!trust) expect((await consume(h.mail.at(-1)?.text ?? '', jar)).status).toBe(403);
      expect(await identityOf(user.sub)).toBeNull();
    });

    it('a break-glass identity disqualifies the account', async () => {
      const member = await stuckMember();
      await run(
        h.env.DB,
        `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at, last_used_at)
       VALUES ('breakglass', ?, ?, NULL, 0, '[]', 0, 0)`,
        [`bg-${uniq()}`, member.id],
      );
      const user = person(member.primaryEmail);
      const jar: Jar = new Map();
      const { res } = await oidcSignIn(h, jar, user);
      expect(res.status).toBe(403);
      if (!trust) expect((await consume(h.mail.at(-1)?.text ?? '', jar)).status).toBe(403);
      expect(await identityOf(user.sub)).toBeNull();
    });
  },
);

describe('lift under trust off', () => {
  beforeEach(() => setOidcTrust(h.env.DB, false));

  it('the code from another browser links nothing; the proof mail warns and keeps the code', async () => {
    const member = await stuckMember();
    const user = person(member.primaryEmail);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, user);
    const text = h.mail.at(-1)?.text ?? '';
    expect(text).toContain('A Polaris ID account is being linked to your PassBook account.');
    expect(text).toContain('Never share this code.');
    const code = /Code: (\d{6})/.exec(text)?.[1] ?? '';
    expect(code).not.toBe('');
    expect((await codeConsume(member.primaryEmail, code, new Map())).status).toBe(400);
    expect(await identityOf(user.sub)).toBeNull();
  });

  it('two proofs consumed at once link exactly one identity', async () => {
    const member = await stuckMember();
    const a = person(member.primaryEmail);
    const b = person(member.primaryEmail);
    const jarA: Jar = new Map();
    const jarB: Jar = new Map();
    await oidcSignIn(h, jarA, a);
    const mailA = h.mail.at(-1)?.text ?? '';
    await oidcSignIn(h, jarB, b);
    const mailB = h.mail.at(-1)?.text ?? '';
    await Promise.all([consume(mailA, jarA), consume(mailB, jarB)]);
    expect(await identityCount(member.id)).toBe(1);
    const audits = await all(
      h.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'auth.identity_linked_moved_primary' AND target_id = ?",
      [member.id],
    );
    expect(audits).toHaveLength(1);
  });

  it('writes the audit with the subject and tells the other verified addresses', async () => {
    const member = await stuckMember();
    const other = `other-${uniq()}@example.test`;
    await run(
      h.env.DB,
      'INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, ?, 0)',
      [other, member.id, 'magic_link'],
    );
    const user = person(member.primaryEmail);
    const jar: Jar = new Map();
    await oidcSignIn(h, jar, user);
    await consume(h.mail.at(-1)?.text ?? '', jar);
    const row = await first<{ actor_type: string; detail: string }>(
      h.env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE action = 'auth.identity_linked_moved_primary' AND target_id = ?",
      [member.id],
    );
    expect(row?.actor_type).toBe('system');
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ provider: 'pocketid', subject: user.sub });
    expect(h.mail.some((m) => m.to === other && m.text.includes('Polaris ID was linked'))).toBe(
      true,
    );
  });
});

describe('secondary address, trust off', () => {
  it('names the main email only after the mail proof', async () => {
    await setOidcTrust(h.env.DB, false);
    const member = await makeUser(fixtures(h.env));
    const added = `added-${uniq()}@example.test`;
    await verifyEmailForUser(createServiceContext(h.env, { clock: h.clock }), member.id, added);
    const jar: Jar = new Map();
    const user = person(added);
    const { res } = await oidcSignIn(h, jar, user);
    expect(await res.text()).not.toContain(maskEmail(member.primaryEmail));
    const refused = await consume(h.mail.at(-1)?.text ?? '', jar);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(maskEmail(member.primaryEmail));
    expect(await identityOf(user.sub)).toBeNull();
  });
});
