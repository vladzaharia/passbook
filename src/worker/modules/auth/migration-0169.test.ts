// Migration 0169's data steps, run over rows a database holds before it (the test database is
// migrated while empty, so these statements never see data otherwise).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0169_sign_in_strength.sql?raw';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { grantScanMembership } from '../scan/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { magicLinkTrace } from './magic-peek.ts';
import { harness, type TestHarness } from './test-support.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);
const DAY = 86_400_000;

/** The statements of 0169 that change rows: the grace backfill, its setting and the invite links. */
const dataSteps = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => /^(INSERT INTO (console_email_grace|settings)|UPDATE magic_links)/.test(s));

beforeEach(async () => {
  h = await harness();
  // Earlier tests of this file leave members behind: only the rows a test makes count.
  await run(h.env.DB, 'UPDATE org_memberships SET revoked_at = 1 WHERE revoked_at IS NULL');
  await run(h.env.DB, 'DELETE FROM console_email_grace');
  await run(h.env.DB, "DELETE FROM settings WHERE key = 'auth.consoleEmailUntil'");
});
afterEach(() => {
  h.restore();
  clearSettingsCache(h.env.DB);
});

const applyData = async () => {
  for (const step of dataSteps) await run(h.env.DB, step);
};

async function member(options: { identity?: boolean; disabled?: boolean; revoked?: boolean } = {}) {
  const user = await makeUser(f());
  const org = await makeOrg(f());
  const membership = await grantScanMembership(f(), org.id, user.id, ['org_admin']);
  if (options.identity)
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 1)`,
      [`sub-${user.id}`, user.id],
    );
  if (options.revoked)
    await run(h.env.DB, 'UPDATE org_memberships SET revoked_at = 1 WHERE id = ?', [membership]);
  if (options.disabled)
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
  return { user, org };
}

describe('migration 0169 over an existing database', () => {
  it('has the three data steps this test runs', () => {
    expect(dataSteps).toHaveLength(3);
  });

  it('puts every active member in grace, whether or not they linked Polaris ID', async () => {
    const plain = await member();
    const linked = await member({ identity: true });
    const disabled = await member({ disabled: true });
    const revoked = await member({ revoked: true });
    const holder = await makeUser(f());
    await applyData();
    const graced = (
      await all<{ user_id: string }>(h.env.DB, 'SELECT user_id FROM console_email_grace')
    ).map((r) => r.user_id);
    expect(graced.sort()).toEqual([plain.user.id, linked.user.id].sort());
    expect(graced).not.toContain(disabled.user.id);
    expect(graced).not.toContain(revoked.user.id);
    expect(graced).not.toContain(holder.id);
  });

  it('sets auth.consoleEmailUntil about 21 days on, only when someone is in grace', async () => {
    await applyData();
    expect(
      await first(h.env.DB, "SELECT 1 FROM settings WHERE key = 'auth.consoleEmailUntil'"),
    ).toBeNull();
    await member();
    await applyData();
    const row = await first<{ value: string }>(
      h.env.DB,
      "SELECT value FROM settings WHERE scope = 'platform' AND key = 'auth.consoleEmailUntil'",
    );
    const until = Number(row?.value);
    const nowMs = Date.now();
    expect(until).toBeGreaterThan(nowMs + 20 * DAY);
    expect(until).toBeLessThan(nowMs + 22 * DAY);
  });

  it('expires unconsumed invite-bound links only, and the trace no longer calls them invited', async () => {
    const org = await makeOrg(f());
    const user = await makeUser(f());
    const membership = await grantScanMembership(f(), org.id, user.id);
    const [invitation] = await all<{ id: string }>(
      h.env.DB,
      'SELECT invitation_id AS id FROM org_memberships WHERE id = ?',
      [membership],
    );
    const now = h.clock.now();
    const link = async (token: string, over: { invitation: boolean; consumed?: boolean }) => {
      await run(
        h.env.DB,
        `INSERT INTO magic_links (token_hash, email, purpose, redirect_path, invitation_id, created_at, expires_at, consumed_at)
         VALUES (?, ?, 'sign_in', '/account', ?, ?, ?, ?)`,
        [
          await sha256Hex(token),
          user.primaryEmail,
          over.invitation ? (invitation?.id ?? null) : null,
          now,
          now + 7 * DAY,
          over.consumed ? now : null,
        ],
      );
    };
    await link('t-invite-live-00000000', { invitation: true });
    await link('t-invite-used-00000000', { invitation: true, consumed: true });
    await link('t-plain-live-000000000', { invitation: false });
    await applyData();
    const expiry = async (token: string) =>
      (
        await first<{ expires_at: number; created_at: number }>(
          h.env.DB,
          'SELECT expires_at, created_at FROM magic_links WHERE token_hash = ?',
          [await sha256Hex(token)],
        )
      )?.expires_at;
    expect(await expiry('t-invite-live-00000000')).toBe(now);
    expect(await expiry('t-invite-used-00000000')).toBe(now + 7 * DAY);
    expect(await expiry('t-plain-live-000000000')).toBe(now + 7 * DAY);
    const ctx = createServiceContext(h.env, { clock: h.clock });
    expect(await magicLinkTrace(ctx, 't-invite-live-00000000')).toMatchObject({
      invited: false,
      invitation: null,
      state: 'expired',
    });
  });
});
