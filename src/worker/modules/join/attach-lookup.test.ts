// A joined card on a template with a desk lookup attaches on new credentials, or not at all.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revealToken } from '../../platform/capability-token.ts';
import { first, run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { listMyPasses } from '../me/service.ts';
import { credentialReferences } from '../passes/credential-references.ts';
import { tombstoneExists } from '../passes/repo-credential-transfer-read.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { lookupHashOf } from '../passes/scan-code.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import { BASE, type PublicKit, publicKit, turnstile, verdictOf } from './public-test-fixtures.ts';

type Joiner = { passId: string; link: string };
const sign = { ipPrefix: null, userAgent: null };
const address = () => `victim-${Math.random().toString(36).slice(2)}@example.test`;

function suite(label: string, lookup: boolean | 'default', body: (t: () => PublicKit) => void) {
  describe(label, () => {
    let t: PublicKit;
    beforeAll(async () => {
      t = await publicKit((id) => joinTemplate(id, undefined, lookup));
    }, 120_000);
    afterAll(() => t.restore());
    beforeEach(async () => {
      await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
      turnstile.verdict = verdictOf();
    });
    body(() => t);
  });
}

async function join(t: PublicKit, email: string, mode: 'live' | 'test' = 'live'): Promise<Joiner> {
  const l = await t.link({ askEmail: true, mode });
  const res = await t.post(l, { email });
  expect(res.status).toBe(303);
  const row = await first<{ id: string }>(
    t.kit.env.DB,
    'SELECT id FROM passes WHERE holder_email = ? ORDER BY id DESC LIMIT 1',
    [email],
  );
  if (!row) throw new Error('no joined pass');
  return { passId: row.id, link: res.headers.get('location') ?? '' };
}

const tombstoned = async (
  t: PublicKit,
  p: { orgId: string; mode: 'live' | 'test' },
  values: { scanCode?: string; lookupValue?: string },
) => {
  const refs = await credentialReferences(t.kit.env, p.orgId, p.mode, values);
  return tombstoneExists(
    t.kit.env.DB,
    p.orgId,
    p.mode,
    refs.map((r) => r.ref),
  );
};

suite('a joined card on a template with a generated desk lookup', true, (get) => {
  it('lands in My passes; the joiner keeps no code, lookup value, link or device token', async () => {
    const t = get();
    const email = address();
    const joiner = await join(t, email);
    const before = await getPass(t.kit.env.DB, joiner.passId);
    if (!before?.scanCode) throw new Error('no joined pass');
    const oldLookup = String(before.personalization.cardNumber);
    expect(oldLookup).toMatch(/^\d{10}$/);
    const oldHash = await lookupHashOf(oldLookup);
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, email, sign);

    const after = await getPass(t.kit.env.DB, joiner.passId);
    expect(after?.ownerUserId).toBe(userId);
    const mine = await listMyPasses(ctx, userId, { limit: 20 });
    expect(mine.items.map((p) => p.id)).toEqual([joiner.passId]);
    expect(mine.reissueRequired).toEqual([]);
    // Every credential a second party could hold is new.
    expect(after?.scanCode).not.toBe(before.scanCode);
    expect(after?.serial).not.toBe(before.serial);
    expect(after?.authToken).not.toBe(before.authToken);
    expect(after?.downloadToken).not.toBe(before.downloadToken);
    expect(after?.linkGeneration).toBeGreaterThan(before.linkGeneration);
    const newLookup = String(after?.personalization.cardNumber);
    expect(newLookup).toMatch(/^\d{10}$/);
    expect(newLookup).not.toBe(oldLookup);
    // The old code and lookup value are retired for the door; the new ones are not.
    expect(await tombstoned(t, before, { scanCode: before.scanCode })).toBe(true);
    expect(await tombstoned(t, before, { lookupValue: oldLookup })).toBe(true);
    expect(await tombstoned(t, before, { lookupValue: newLookup })).toBe(false);
    if (!after?.scanCode) throw new Error('no new code');
    expect(await tombstoned(t, before, { scanCode: after.scanCode })).toBe(false);
    // A desk lookup by the old value finds nothing; by the new value finds the card.
    const byHash = (h: string) =>
      first<{ id: string }>(
        t.kit.env.DB,
        'SELECT id FROM passes WHERE org_id = ? AND mode = ? AND lookup_hash = ?',
        [before.orgId, before.mode, h],
      );
    expect(await byHash(oldHash)).toBeNull();
    expect((await byHash(await lookupHashOf(newLookup)))?.id).toBe(joiner.passId);
    // The link the joiner holds is dead; the owner's new link opens the card.
    expect((await t.app.request(`${BASE}${joiner.link}`, {}, t.kit.env)).status).toBe(404);
    const fresh = await revealToken(
      t.kit.env,
      'pass',
      joiner.passId,
      before.orgId,
      after.downloadToken,
    );
    expect((await t.app.request(`${BASE}/p/${fresh}`, {}, t.kit.env)).status).toBe(200);
  });

  it('touches no other card, and tombstones only its own org and mode', async () => {
    const t = get();
    const sibling = await join(t, address());
    const siblingBefore = await getPass(t.kit.env.DB, sibling.passId);
    const email = address();
    const joiner = await join(t, email);
    const before = await getPass(t.kit.env.DB, joiner.passId);
    if (!before?.scanCode || !siblingBefore) throw new Error('no joined pass');
    await signInMagicLink(jobCtxOf(t.kit), email, sign);
    const siblingAfter = await getPass(t.kit.env.DB, sibling.passId);
    expect(siblingAfter?.scanCode).toBe(siblingBefore.scanCode);
    expect(siblingAfter?.downloadToken).toBe(siblingBefore.downloadToken);
    expect(siblingAfter?.personalization).toEqual(siblingBefore.personalization);
    const old = {
      scanCode: before.scanCode,
      lookupValue: String(before.personalization.cardNumber),
    };
    const other = before.mode === 'live' ? 'test' : 'live';
    expect(await tombstoned(t, before, old)).toBe(true);
    expect(await tombstoned(t, { orgId: before.orgId, mode: other }, old)).toBe(false);
    expect(await tombstoned(t, { orgId: 'another-org', mode: before.mode }, old)).toBe(false);
  });

  it('a test-mode card rotates in test mode only, and a retry changes nothing', async () => {
    const t = get();
    const email = address();
    const joiner = await join(t, email, 'test');
    const before = await getPass(t.kit.env.DB, joiner.passId);
    if (!before?.scanCode) throw new Error('no joined pass');
    expect(before.mode).toBe('test');
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, email, sign);
    const after = await getPass(t.kit.env.DB, joiner.passId);
    expect(after?.ownerUserId).toBe(userId);
    expect(after?.scanCode).not.toBe(before.scanCode);
    expect(await tombstoned(t, before, { scanCode: before.scanCode })).toBe(true);
    expect(
      await tombstoned(t, { orgId: before.orgId, mode: 'live' }, { scanCode: before.scanCode }),
    ).toBe(false);
    // Signing in again attaches nothing more: no second rotation.
    await signInMagicLink(ctx, email, sign);
    const again = await getPass(t.kit.env.DB, joiner.passId);
    expect(again?.version).toBe(after?.version);
    expect(again?.scanCode).toBe(after?.scanCode);
    expect(again?.personalization).toEqual(after?.personalization);
    expect(again?.linkGeneration).toBe(after?.linkGeneration);
  });
});

suite('a joined card whose lookup value is the same for every card', 'default', (get) => {
  it('does not attach: the owner is told it needs a new copy, the joiner keeps only their card', async () => {
    const t = get();
    const victim = address();
    const joiner = await join(t, victim);
    const before = await getPass(t.kit.env.DB, joiner.passId);
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, victim, sign);
    // Linking as it is would leave the joiner's link and code working on a card in the victim's account.
    const after = await getPass(t.kit.env.DB, joiner.passId);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.linkGeneration).toBe(before?.linkGeneration);
    expect(after?.scanCode).toBe(before?.scanCode);
    const mine = await listMyPasses(ctx, userId, { limit: 20 });
    expect(mine.items).toEqual([]);
    expect(mine.reissueRequired.map((r) => r.passId)).toEqual([joiner.passId]);
    expect((await t.app.request(`${BASE}${joiner.link}`, {}, t.kit.env)).status).toBe(200);
  });
});
