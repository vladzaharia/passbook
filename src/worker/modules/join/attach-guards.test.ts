// What the joined-card rotation holds to: the card's own version, a permanent mark, a split start and finish.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { listMyPasses } from '../me/service.ts';
import { credentialReferences } from '../passes/credential-references.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { joinAttachContent } from '../passes/credential-transfer-join.ts';
import { readTransferPass, tombstoneExists } from '../passes/repo-credential-transfer-read.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import { type PublicKit, publicKit, turnstile, verdictOf } from './public-test-fixtures.ts';

const sign = { ipPrefix: null, userAgent: null };
const address = () => `guard-${Math.random().toString(36).slice(2)}@example.test`;

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

async function join(t: PublicKit, email: string) {
  const l = await t.link({ askEmail: true });
  expect((await t.post(l, { email })).status).toBe(200);
  const row = await first<{ id: string }>(
    t.kit.env.DB,
    'SELECT id FROM passes WHERE holder_email = ? ORDER BY id DESC LIMIT 1',
    [email],
  );
  if (!row) throw new Error('no joined pass');
  return { passId: row.id, link: l };
}

const retired = async (t: PublicKit, orgId: string, lookupValue: string) => {
  const refs = await credentialReferences(t.kit.env, orgId, 'live', { lookupValue });
  return tombstoneExists(
    t.kit.env.DB,
    orgId,
    'live',
    refs.map((r) => r.ref),
  );
};

suite('a joined card whose lookup value was a shared default', 'default', (get) => {
  it('is not replaced when a later release would have the join generate it', async () => {
    const t = get();
    const { passId } = await join(t, address());
    const source = await readTransferPass(t.kit.env.DB, passId);
    if (!source) throw new Error('no source');
    const base = await t.kit.registry.resolve(t.kit.template.id, 'v1');
    const manifest = structuredClone(base.manifest);
    manifest.inputs = {
      ...manifest.inputs,
      required: ['memberName', 'cardNumber'],
      properties: {
        ...manifest.inputs.properties,
        cardNumber: { type: 'string', minLength: 1 },
      },
    };
    t.kit.registry.add({
      id: base.id,
      orgId: base.orgId,
      version: 'v2',
      manifest,
      passJson: base.passJson,
      assets: {},
    });
    const content = { personalization: source.pass.personalization, fieldSources: {} };
    const ctx = jobCtxOf(t.kit);
    // The head alone would call cardNumber generated; the card's own version had it as a default.
    const moved = await joinAttachContent(ctx, 'transfer-1', source, 'v2', content, 'owner-1');
    expect(moved.replaced).toBe(false);
    expect(moved.content).toBe(content);
  });

  it('stays marked as joined after its link is deleted, so it still is not attached as it is', async () => {
    const t = get();
    const email = address();
    const { passId, link } = await join(t, email);
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM join_marks WHERE pass_id = ?', [passId]),
    ).not.toBeNull();
    await run(t.kit.env.DB, 'DELETE FROM join_links WHERE id = ?', [link.id]);
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM join_issues WHERE pass_id = ?', [passId]),
    ).toBeNull();
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM join_marks WHERE pass_id = ?', [passId]),
    ).not.toBeNull();
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, email, sign);
    expect((await getPass(t.kit.env.DB, passId))?.ownerUserId).toBeNull();
    expect(
      (await listMyPasses(ctx, userId, { limit: 20 })).reissueRequired.map((r) => r.passId),
    ).toEqual([passId]);
  });

  it('keeps the mark: it cannot be changed or deleted while the pass exists', async () => {
    const t = get();
    const { passId } = await join(t, address());
    await expect(
      run(t.kit.env.DB, "UPDATE join_marks SET mode = 'test' WHERE pass_id = ?", [passId]),
    ).rejects.toThrow(/never changes/);
    await expect(
      run(t.kit.env.DB, 'DELETE FROM join_marks WHERE pass_id = ?', [passId]),
    ).rejects.toThrow(/goes with its pass/);
    const marks = await all(
      t.kit.env.DB,
      'SELECT 1 FROM join_marks m JOIN join_issues i ON i.pass_id = m.pass_id',
    );
    expect(marks.length).toBeGreaterThan(0);
  });
});

suite('a joined card on a generated lookup, start and finish apart', true, (get) => {
  it('retires the old lookup at start, replaces it at finish, and a second finish changes nothing', async () => {
    const t = get();
    const email = address();
    const { passId } = await join(t, email);
    const before = await getPass(t.kit.env.DB, passId);
    if (!before) throw new Error('no pass');
    const oldLookup = String(before.personalization.cardNumber);
    // The storage write inside finish fails once: start has committed, finish is left to a later call.
    const put = vi
      .spyOn(t.kit.env.BUCKET, 'put')
      .mockRejectedValueOnce(new Error('r2 unavailable'));
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, email, sign);
    put.mockRestore();
    const mid = await getPass(t.kit.env.DB, passId);
    expect(mid?.ownerUserId).toBeNull();
    expect(mid?.linkGeneration).toBeGreaterThan(before.linkGeneration);
    expect(mid?.personalization.cardNumber).toBe(oldLookup);
    expect(await retired(t, before.orgId, oldLookup)).toBe(true);
    const transfer = await first<{ id: string; state: string }>(
      t.kit.env.DB,
      'SELECT id, state FROM pass_credential_transfers WHERE pass_id = ?',
      [passId],
    );
    expect(transfer?.state).toBe('pending');

    expect(await finishCredentialTransfer(ctx, transfer?.id ?? '')).toEqual({
      transferId: transfer?.id,
      state: 'completed',
    });
    const after = await getPass(t.kit.env.DB, passId);
    expect(after?.ownerUserId).toBe(userId);
    const replaced = String(after?.personalization.cardNumber);
    expect(replaced).toMatch(/^\d{10}$/);
    expect(replaced).not.toBe(oldLookup);
    expect(await retired(t, before.orgId, replaced)).toBe(false);

    await finishCredentialTransfer(ctx, transfer?.id ?? '');
    const again = await getPass(t.kit.env.DB, passId);
    expect(again?.version).toBe(after?.version);
    expect(again?.personalization.cardNumber).toBe(replaced);
    const audits = await all(
      t.kit.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'pass.join_lookup_replaced' AND target_id = ?",
      [passId],
    );
    expect(audits).toHaveLength(1);
  });
});
