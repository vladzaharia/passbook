import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { rollbackRelease } from '../templates/releases.ts';
import { approvedForTransfer, buildTransfer } from './credential-transfer-build.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { readTransferPass } from './repo-credential-transfer-read.ts';
import { getPass } from './repo-read-pass.ts';
import { reissueStamps, releaseStamps, stampCard, stampVersion } from './stamps-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const stamps = async (id: string) => (await getPass(kit.env.DB, id))?.personalization.stamps;
const versionOf = async (id: string) => (await getPass(kit.env.DB, id))?.templateVersion;

const api = (path: string, init: RequestInit) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    { ...init, headers: { ...auth.admin(), 'content-type': 'application/json', ...init.headers } },
    kit.env,
  );

describe('moving a Stamp card to another version', () => {
  it('tops a ready card up once across release, rollback and release again', async () => {
    const id = 'tpl-move-cycle';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const card = await stampCard(kit, v1, 10);
    await stampVersion(kit, id, 'v2', 12, { keepReady: true });
    const v2 = await releaseStamps(kit, id, 'v2');
    await reissueStamps(kit, id);
    expect(await stamps(card.id)).toBe(12);
    expect(await versionOf(card.id)).toBe('v2');
    await rollbackRelease(kit.ctx, v2.publisherAuth, id, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      releaseId: v1.id,
      candidateHash: v1.candidateHash,
      expectedGeneration: v2.generation,
      reason: 'Back to the ten-stamp card.',
    });
    await reissueStamps(kit, id);
    expect(await versionOf(card.id)).toBe('v1');
    // A holder keeps the reward they were shown.
    expect(await stamps(card.id)).toBe(12);
    await releaseStamps(kit, id, 'v2');
    await reissueStamps(kit, id);
    expect(await versionOf(card.id)).toBe('v2');
    expect(await stamps(card.id)).toBe(12);
  });

  it('tops up once on a PATCH to the new version', async () => {
    const id = 'tpl-move-patch';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const card = await stampCard(kit, v1, 10);
    const short = await stampCard(kit, v1, 4);
    await stampVersion(kit, id, 'v2', 12, { keepReady: true });
    await releaseStamps(kit, id, 'v2');
    for (const pass of [card, short]) {
      const res = await api(`/passes/${pass.id}`, {
        method: 'PATCH',
        headers: { 'if-match': String((await getPass(kit.env.DB, pass.id))?.version) },
        body: JSON.stringify({ templateVersion: 'v2' }),
      });
      expect(res.status).toBe(200);
    }
    expect(await versionOf(card.id)).toBe('v2');
    expect(await stamps(card.id)).toBe(12);
    // A card that was not ready has nothing to keep.
    expect(await stamps(short.id)).toBe(4);
    const again = await api(`/passes/${card.id}`, {
      method: 'PATCH',
      headers: { 'if-match': String((await getPass(kit.env.DB, card.id))?.version) },
      body: JSON.stringify({ templateVersion: 'v2' }),
    });
    expect(again.status).toBe(200);
    expect(await stamps(card.id)).toBe(12);
  });

  it('refuses a PATCH that would put a card above the new maximum', async () => {
    const id = 'tpl-move-patch-max';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const card = await stampCard(kit, v1, 15);
    await stampVersion(kit, id, 'v2', 5, { maximum: 9 });
    await run(kit.env.DB, 'UPDATE passes SET template_version = template_version WHERE id = ?', [
      card.id,
    ]);
    const res = await api(`/passes/${card.id}`, {
      method: 'PATCH',
      headers: { 'if-match': String((await getPass(kit.env.DB, card.id))?.version) },
      body: JSON.stringify({ templateVersion: 'v2' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STAMPS_ABOVE_MAX' });
    expect(await stamps(card.id)).toBe(15);
    expect(await versionOf(card.id)).toBe('v1');
  });

  it('tops up a pass with no issued release that a transfer moves to the head', async () => {
    const id = 'tpl-move-transfer';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const card = await stampCard(kit, v1, 10);
    await stampVersion(kit, id, 'v2', 12, { keepReady: true });
    await releaseStamps(kit, id, 'v2');
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [card.id]);
    const source = await readTransferPass(kit.env.DB, card.id);
    if (!source) throw new Error('Missing transfer source');
    const release = await approvedForTransfer(kit.ctx, source);
    expect(release.version).toBe('v2');
    const build = await buildTransfer(kit.ctx, source, release, {
      personalization: source.pass.personalization,
      fieldSources: source.pass.fieldSources,
    });
    expect(build.content.personalization.stamps).toBe(12);
    expect(Object.keys(build.content.fieldSources)).toContain('stamps.kept:12');
    // A pass already on the head version is not moved.
    const same = await buildTransfer(
      kit.ctx,
      { ...source, pass: { ...source.pass, templateVersion: 'v2' } },
      release,
      { personalization: source.pass.personalization, fieldSources: source.pass.fieldSources },
    );
    expect(same.content.personalization.stamps).toBe(10);
  });
});

describe('a card above the new maximum', () => {
  it('stops climbing at a pending release and fails its reissue with a stable code', async () => {
    const id = 'tpl-move-above';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const card = await stampCard(kit, v1, 8);
    await stampVersion(kit, id, 'v2', 5, { maximum: 9 });
    await releaseStamps(kit, id, 'v2');
    // v1 allows 19, the pending v2 allows 9: the card stops at 9.
    const add = (count: number) =>
      api(`/passes/${card.id}/stamps`, {
        method: 'POST',
        body: JSON.stringify({ action: 'add', count }),
      });
    expect((await add(1)).status).toBe(200);
    const full = await add(1);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'STAMPS_CARD_FULL' });
    expect(await stamps(card.id)).toBe(9);
    // The reissue moves it: 9 fits.
    expect(await reissueStamps(kit, id)).toMatchObject({ failed: 0 });
    expect(await versionOf(card.id)).toBe('v2');
  });

  it('is counted and left alone by the reissue, never trimmed', async () => {
    const id = 'tpl-move-above-reissue';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const over = await stampCard(kit, v1, 6);
    const fits = await stampCard(kit, v1, 6);
    await stampVersion(kit, id, 'v2', 5, { maximum: 9 });
    await releaseStamps(kit, id, 'v2');
    // A card that passed the release guard and then climbed (a write the guard never saw).
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.stamps', 15) WHERE id = ?",
      [over.id],
    );
    expect(await reissueStamps(kit, id)).toMatchObject({ failed: 1, aboveMax: 1, changed: 1 });
    expect(await stamps(over.id)).toBe(15);
    expect(await versionOf(over.id)).toBe('v1');
    // The rollout view can say why: one row for the pass left behind, none for the one that moved.
    expect(
      await all(kit.env.DB, 'SELECT pass_id, code FROM template_rollout_failures', []),
    ).toEqual([{ pass_id: over.id, code: 'STAMPS_ABOVE_MAX' }]);
    expect(await stamps(fits.id)).toBe(6);
    expect(await versionOf(fits.id)).toBe('v2');
  });

  it('finishes the page when the failure note cannot be written', async () => {
    const id = 'tpl-move-above-noted';
    await stampVersion(kit, id, 'v1', 10);
    const v1 = await releaseStamps(kit, id, 'v1');
    const over = await stampCard(kit, v1, 6);
    const fits = await stampCard(kit, v1, 6);
    await stampVersion(kit, id, 'v2', 5, { maximum: 9 });
    await releaseStamps(kit, id, 'v2');
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.stamps', 15) WHERE id = ?",
      [over.id],
    );
    // Bookkeeping only: without its table the run still moves the others and reports the failure.
    await run(
      kit.env.DB,
      'ALTER TABLE template_rollout_failures RENAME TO template_rollout_failures_off',
      [],
    );
    try {
      expect(await reissueStamps(kit, id)).toMatchObject({ failed: 1, changed: 1 });
    } finally {
      await run(
        kit.env.DB,
        'ALTER TABLE template_rollout_failures_off RENAME TO template_rollout_failures',
        [],
      );
    }
    expect(await versionOf(fits.id)).toBe('v2');
    expect(await versionOf(over.id)).toBe('v1');
  });
});
