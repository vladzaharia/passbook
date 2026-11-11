import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { mintAssetGrant } from './assets.ts';
import { scannerCandidateAllowed } from './member-photo.ts';
import { candidateById } from './repo-lookup.ts';
import { candidateInScope } from './resolve.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Asset event scope', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function setup(tier: string) {
  const event = await kit.event({ templateIds: [template] });
  await run(
    kit.env.DB,
    `UPDATE scan_events SET match_input = 'tier', match_values = '["gold"]',
    updated_at = updated_at + 1 WHERE id = ?`,
    [event.id],
  );
  const scanner = await kit.scanner({ eventId: event.id });
  const actor = await assetActorFor(kit, scanner);
  const pass = await kit.scanPass(template, { tier });
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate) throw new Error('Pass fixture missing');
  return { scanner, actor, pass, candidate };
}

describe('scanner asset event scope', () => {
  it('does not mint even generic images for an event-filtered pass', async () => {
    const { actor, candidate } = await setup('silver');
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('uses the same fail-closed event filter for member and live projections', async () => {
    const { actor, candidate } = await setup('gold');
    if (!actor.event || !candidate.passJsonSnapshot) throw new Error('Event fixture missing');
    const passJson = JSON.parse(candidate.passJsonSnapshot) as PassJson;
    expect(scannerCandidateAllowed(actor, candidate, passJson, kit.clock.now())).toBe(true);
    for (const event of [
      { ...actor.event, matchInput: null },
      { ...actor.event, matchValues: null },
      { ...actor.event, matchValues: '[]' },
      { ...actor.event, matchValues: '["gold",1]' },
      { ...actor.event, matchValues: '{' },
      { ...actor.event, matchInput: 'missing' },
    ]) {
      expect(
        scannerCandidateAllowed({ ...actor, event }, candidate, passJson, kit.clock.now()),
      ).toBe(false);
    }
  });

  it.each([
    [true, '1', '0'],
    [false, '0', '1'],
  ] as const)(
    'matches boolean event inputs using SQLite text semantics',
    async (value, expected, other) => {
      const { actor, candidate } = await setup('gold');
      if (!actor.event || !candidate.passJsonSnapshot) throw new Error('Event fixture missing');
      const passJson = JSON.parse(candidate.passJsonSnapshot) as PassJson;
      const changed = {
        ...candidate,
        pass: {
          ...candidate.pass,
          personalization: { ...candidate.pass.personalization, tier: value },
        },
      };
      const matching = {
        ...actor,
        event: { ...actor.event, matchValues: JSON.stringify([expected]) },
      };
      const nonmatching = {
        ...actor,
        event: { ...actor.event, matchValues: JSON.stringify([other]) },
      };
      expect(scannerCandidateAllowed(matching, changed, passJson, kit.clock.now())).toBe(true);
      expect(scannerCandidateAllowed(nonmatching, changed, passJson, kit.clock.now())).toBe(false);
    },
  );

  it('honors a session template override instead of a scanner’s pinned event', async () => {
    const { actor, candidate } = await setup('gold');
    if (!candidate.passJsonSnapshot) throw new Error('Pass fixture missing');
    const passJson = JSON.parse(candidate.passJsonSnapshot) as PassJson;
    const sessionActor = {
      ...actor,
      event: null,
      templateIds: [template],
      scanningSession: { id: 'session', status: 'active' as const, updatedAt: kit.clock.now() },
    };
    expect(scannerCandidateAllowed(sessionActor, candidate, passJson, kit.clock.now())).toBe(true);
    expect(
      scannerCandidateAllowed(
        { ...sessionActor, templateIds: [] },
        candidate,
        passJson,
        kit.clock.now(),
      ),
    ).toBe(false);
    expect(candidateInScope(sessionActor, candidate)).toBe(true);
    expect(candidateInScope({ ...sessionActor, templateIds: [] }, candidate)).toBe(false);
  });

  it('allows a standalone staffless monitor but denies customers and unscoped sessions', async () => {
    const { candidate } = await setup('gold');
    const monitor = await kit.scanner({ deviceRole: 'monitor' });
    const actor = await assetActorFor(kit, monitor);
    if (!actor.scanner) throw new Error('Monitor fixture missing');
    const standalone = {
      ...actor,
      role: null,
      event: null,
      templateIds: [],
      settings: { ...actor.settings, acceptAllTemplates: false },
    };
    expect(candidateInScope(standalone, candidate)).toBe(true);
    expect(candidateInScope({ ...standalone, invalidScannerScope: true }, candidate)).toBe(false);
    expect(
      candidateInScope(
        {
          ...standalone,
          scanner: { ...actor.scanner, deviceRole: 'customer' },
        },
        candidate,
      ),
    ).toBe(false);
    expect(
      candidateInScope(
        {
          ...standalone,
          scanningSession: { id: 'session', status: 'active', updatedAt: kit.clock.now() },
        },
        candidate,
      ),
    ).toBe(false);
    expect(
      candidateInScope(
        {
          ...standalone,
          templateIds: [template],
          scanningSession: { id: 'session', status: 'paused', updatedAt: kit.clock.now() },
        },
        candidate,
      ),
    ).toBe(false);
  });

  it('does not mint from an evaluated match after its pass data changes', async () => {
    const { scanner, actor, pass, candidate } = await setup('gold');
    const grant = await mintAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      undefined,
      false,
      'commit',
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.tier', 'silver') WHERE id = ?",
      [pass.id],
    );
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });
});
