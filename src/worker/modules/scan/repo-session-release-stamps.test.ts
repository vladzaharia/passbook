import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  captureTemplateStamps,
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  sessionTemplateStampsPredicate,
} from './repo-scope-releases.ts';
import { approveScanReleases, makeLegacyScanPass, type ScanKit, setupScanKit } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let kit: ScanKit;

beforeEach(async () => {
  kit = await setupScanKit();
});

async function sessionTemplateStampsCurrent(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
): Promise<boolean> {
  const predicate = sessionTemplateStampsPredicate(releases, legacy, 'scope.org_id', 'scope.mode');
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM (SELECT ? AS org_id, ? AS mode) scope WHERE ${predicate.sql}`,
    [orgId, mode, ...predicate.params],
  );
  return row?.ok === 1;
}

async function scenario() {
  const approved = await kit.scanTemplate('Released session template', { actions: [CHECK_IN] });
  const legacy = await kit.scanTemplate(
    'Legacy session template',
    { actions: [CHECK_IN] },
    { releaseModes: [] },
  );
  const pinned = await kit.registry.resolve(legacy);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template: pinned });
  const captured = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [approved, legacy]);
  if (!captured) throw new Error('Missing template stamps.');
  return {
    approved,
    legacy,
    pinned,
    pass,
    releases: captured.releases,
    legacyStamps: captured.legacy,
  };
}

describe('atomic session release stamps', () => {
  // A stamp is fenced by its bound release row, not by staying the head.
  it('keeps a captured release through head replacement, not through template deletion', async () => {
    const s = await scenario();
    const stamped = () =>
      sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, s.legacyStamps);
    expect(await stamped()).toBe(true);
    await approveScanReleases(kit, s.approved, { modes: ['live'] });
    expect(await stamped()).toBe(true);
    const release = s.releases[0];
    if (!release) throw new Error('Missing release stamp.');
    const forged = [{ ...release, generation: release.generation + 1 }];
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', forged, s.legacyStamps),
    ).toBe(false);
    await run(kit.env.DB, "UPDATE templates SET status='deleted' WHERE id=?", [s.approved]);
    expect(await stamped()).toBe(false);
  });

  it('fences exact legacy version sets, not newly published release history', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,report,created_by,created_at,build_key)
      SELECT template_id,'v2',manifest,pass_json,assets,report,created_by,created_at,build_key
      FROM template_versions WHERE template_id=? AND version=?`,
      [s.legacy, s.pinned.version],
    );
    const second = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template: s.pinned });
    await run(kit.env.DB, "UPDATE passes SET template_version='v2' WHERE id=?", [second.id]);
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        s.releases,
        s.legacyStamps,
      ),
    ).toBe(false);
    const fresh = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [s.legacy]);
    if (!fresh?.legacy[0]) throw new Error('Missing legacy evidence.');
    const current = [{ ...fresh.legacy[0], versions: [...fresh.legacy[0].versions].reverse() }];
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, current),
    ).toBe(true);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [
      kit.clock.now(),
      s.pass.id,
    ]);
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, current),
    ).toBe(false);
    const remaining = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [s.legacy]);
    if (!remaining) throw new Error('Missing remaining legacy evidence.');
    await approveScanReleases(kit, s.legacy, { modes: ['live'], version: s.pinned.version });
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        s.releases,
        remaining.legacy,
      ),
    ).toBe(true);
  });

  it('fences the latest persisted legacy Wallet identity but does not discard expired scopes', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?",
      [new Date(kit.clock.now() - 1_000).toISOString(), s.pass.id],
    );
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        s.releases,
        s.legacyStamps,
      ),
    ).toBe(true);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.serialNumber','wrong') WHERE pass_id=?",
      [s.pass.id],
    );
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        s.releases,
        s.legacyStamps,
      ),
    ).toBe(false);
  });

  it('rejects signing identity ABA even when the final Wallet identity matches again', async () => {
    const s = await scenario();
    const scanner = await kit.scanner();
    const predicate = sessionTemplateStampsPredicate(
      s.releases,
      s.legacyStamps,
      's.org_id',
      's.mode',
    );
    const identity = await first<{ id: string; pass_type_identifier: string; revision: number }>(
      kit.env.DB,
      `SELECT si.id,si.pass_type_identifier,si.revision FROM signing_identities si
       JOIN passes p ON p.identity_id=si.id WHERE p.id=?`,
      [s.pass.id],
    );
    if (!identity) throw new Error('Missing signing identity.');
    await run(kit.env.DB, 'UPDATE signing_identities SET pass_type_identifier=? WHERE id=?', [
      `${identity.pass_type_identifier}.changed`,
      identity.id,
    ]);
    await run(kit.env.DB, 'UPDATE signing_identities SET pass_type_identifier=? WHERE id=?', [
      identity.pass_type_identifier,
      identity.id,
    ]);
    const currentIdentity = await first<{ revision: number }>(
      kit.env.DB,
      'SELECT revision FROM signing_identities WHERE id=?',
      [identity.id],
    );
    expect(currentIdentity?.revision).toBeGreaterThan(identity.revision);
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        s.releases,
        s.legacyStamps,
      ),
    ).toBe(false);
    expect(
      (
        await run(
          kit.env.DB,
          `UPDATE scanners AS s SET name='stale' WHERE s.id=? AND (${predicate.sql})`,
          [scanner.id, ...predicate.params],
        )
      ).changes,
    ).toBe(0);
    const fresh = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [
      s.approved,
      s.legacy,
    ]);
    if (!fresh) throw new Error('Missing fresh template stamps.');
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        fresh.releases,
        fresh.legacy,
      ),
    ).toBe(true);
  });

  it('captures mixed scopes and fences a configuration write after template deletion', async () => {
    const s = await scenario();
    const captured = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [
      s.approved,
      s.legacy,
    ]);
    if (!captured) throw new Error('Missing mixed template stamps.');
    expect(captured).toEqual({ releases: s.releases, legacy: s.legacyStamps });
    expect(await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [])).toEqual({
      releases: [],
      legacy: [],
    });
    expect(
      await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [s.approved, s.approved]),
    ).toBeNull();
    const missing = await kit.scanTemplate(
      'Missing head',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    expect(
      await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [s.approved, missing]),
    ).toBeNull();
    const scanner = await kit.scanner();
    const predicate = sessionTemplateStampsPredicate(
      captured.releases,
      captured.legacy,
      's.org_id',
      's.mode',
    );
    expect(
      (
        await run(
          kit.env.DB,
          `UPDATE scanners AS s SET name='current' WHERE s.id=? AND (${predicate.sql})`,
          [scanner.id, ...predicate.params],
        )
      ).changes,
    ).toBe(1);
    const write = async (name: string) =>
      (
        await run(
          kit.env.DB,
          `UPDATE scanners AS s SET name=? WHERE s.id=? AND (${predicate.sql})`,
          [name, scanner.id, ...predicate.params],
        )
      ).changes;
    await approveScanReleases(kit, s.approved, { modes: ['live'] });
    expect(await write('after head')).toBe(1);
    await run(kit.env.DB, "UPDATE templates SET status='deleted' WHERE id=?", [s.approved]);
    expect(await write('stale')).toBe(0);
  });

  it('denies foreign mode or tenant, malformed heads, duplicate templates and duplicate versions', async () => {
    const s = await scenario();
    const other = await makeOrg(kit.fx);
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, other.id, 'live', s.releases, s.legacyStamps),
    ).toBe(false);
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'test',
        s.releases,
        s.legacyStamps,
      ),
    ).toBe(false);
    expect(
      await sessionTemplateStampsCurrent(
        kit.env.DB,
        kit.org.id,
        'live',
        [{ ...s.releases[0]!, candidateHash: '' }],
        s.legacyStamps,
      ),
    ).toBe(false);
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, [
        { ...s.legacyStamps[0]!, versions: [s.pinned.version, s.pinned.version] },
      ]),
    ).toBe(false);
    const identity = s.legacyStamps[0]?.identities[0];
    if (!identity) throw new Error('Missing legacy identity stamp.');
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, [
        { ...s.legacyStamps[0]!, identities: [{ ...identity, identityRevision: 0 }] },
      ]),
    ).toBe(false);
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, [
        { ...s.legacyStamps[0]!, identities: [identity, identity] },
      ]),
    ).toBe(false);
    expect(
      await sessionTemplateStampsCurrent(kit.env.DB, kit.org.id, 'live', s.releases, [
        { ...s.legacyStamps[0]!, templateId: s.approved },
      ]),
    ).toBe(false);
  });
});
