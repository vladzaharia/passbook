import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import {
  actionPassFence,
  passSnapshotCurrent,
  passSnapshotCurrentStrict,
  passSnapshotFence,
} from './repo-pass-authority.ts';
import { policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, changeAwayAndBack, afterCandidateRead, atGate, requestOf } =
  policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner evaluated policy revisions', () => {
  it('does not bless a candidate captured during a transfer after it is no longer pending', async () => {
    const s = await scenario();
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate?.activeTemplateVersion) throw new Error('Missing candidate');
    const pending = { ...candidate, transferPending: true };
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        pending.pass,
        pending.connectionGeneration,
        pending.activeTemplateVersion,
        pending.orgRevision,
        pending.templateRevision,
        kit.clock.now(),
        pending,
      ),
    ).toBe(false);
    expect(
      await passSnapshotCurrentStrict(
        kit.env.DB,
        pending.pass,
        pending.connectionGeneration,
        pending.activeTemplateVersion,
        pending.orgRevision,
        pending.templateRevision,
        kit.clock.now(),
        pending,
      ),
    ).toBe(false);
    expect(
      await passSnapshotFence(
        kit.env.DB,
        pending.pass,
        pending.checkInRules,
        pending.connectionGeneration,
        pending.activeTemplateVersion,
        pending.orgRevision,
        pending.templateRevision,
        kit.clock.now(),
        kit.env,
        pending,
      ),
    ).toBeNull();
  });

  it.each(['organization', 'template'] as const)(
    'fences the candidate read against a %s ABA before mint and admission',
    async (policy) => {
      const s = await scenario();
      const snapshot = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!snapshot?.activeTemplateVersion) throw new Error('Missing active candidate');
      const version = snapshot.activeTemplateVersion;
      const org = await first<{ updated_at: number }>(
        kit.env.DB,
        'SELECT updated_at FROM orgs WHERE id=?',
        [kit.org.id],
      );
      const template = await first<{ updated_at: number }>(
        kit.env.DB,
        'SELECT updated_at FROM templates WHERE id=?',
        [s.templateId],
      );
      expect(snapshot.orgRevision).toBe(org?.updated_at);
      expect(snapshot.templateRevision).toBe(template?.updated_at);
      expect(
        await passSnapshotCurrent(
          kit.env.DB,
          snapshot.pass,
          snapshot.connectionGeneration,
          version,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          snapshot,
        ),
      ).toBe(true);
      expect(
        await passSnapshotFence(
          kit.env.DB,
          snapshot.pass,
          snapshot.checkInRules,
          snapshot.connectionGeneration,
          version,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          kit.env,
          snapshot,
        ),
      ).toMatchObject({
        activeTemplateVersion: version,
        orgRevision: snapshot.orgRevision,
        templateRevision: snapshot.templateRevision,
      });
      expect(
        await passSnapshotCurrent(
          kit.env.DB,
          snapshot.pass,
          snapshot.connectionGeneration,
          `${version}-different`,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          snapshot,
        ),
      ).toBe(false);
      expect(
        await passSnapshotFence(
          kit.env.DB,
          snapshot.pass,
          snapshot.checkInRules,
          snapshot.connectionGeneration,
          null,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          kit.env,
          snapshot,
        ),
      ).toBeNull();
      const grant = await mintAssetGrant(
        kit.ctx,
        s.actor,
        snapshot,
        snapshot.connectionGeneration,
        version,
      );
      expect(typeof grant).toBe('string');
      const assetPath = `/passes/${s.pass.id}/assets/icon.png?g=`;
      expect(
        (await kit.get(s.scanner.headers, `${assetPath}${encodeURIComponent(grant)}`)).status,
      ).toBe(200);

      await changeAwayAndBack(kit.env.DB, policy, s.templateId);
      const fresh = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!fresh?.activeTemplateVersion) throw new Error('Missing refreshed candidate');
      expect(fresh.pass).toEqual(snapshot.pass);
      expect(fresh.activeTemplateVersion).toBe(version);
      expect(policy === 'organization' ? fresh.orgRevision : fresh.templateRevision).toBe(
        (policy === 'organization' ? snapshot.orgRevision! : snapshot.templateRevision!) + 2,
      );
      expect(
        await passSnapshotCurrent(
          kit.env.DB,
          snapshot.pass,
          snapshot.connectionGeneration,
          version,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          snapshot,
        ),
      ).toBe(false);
      expect(
        await passSnapshotFence(
          kit.env.DB,
          snapshot.pass,
          snapshot.checkInRules,
          snapshot.connectionGeneration,
          version,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          kit.env,
          snapshot,
        ),
      ).toBeNull();
      expect(
        await actionPassFence(
          kit.env.DB,
          snapshot.pass,
          snapshot.checkInRules,
          snapshot.connectionGeneration,
          version,
          snapshot.orgRevision,
          snapshot.templateRevision,
          kit.clock.now(),
          kit.env,
          snapshot,
        ),
      ).toBeNull();
      await expect(
        mintAssetGrant(kit.ctx, s.actor, snapshot, snapshot.connectionGeneration, version),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
      expect(
        (await kit.get(s.scanner.headers, `${assetPath}${encodeURIComponent(grant)}`)).status,
      ).toBe(404);
      const freshGrant = await mintAssetGrant(
        kit.ctx,
        s.actor,
        fresh,
        fresh.connectionGeneration,
        fresh.activeTemplateVersion,
      );
      expect(
        (await kit.get(s.scanner.headers, `${assetPath}${encodeURIComponent(freshGrant)}`)).status,
      ).toBe(200);
    },
  );

  it.each([
    'orgRevision',
    'templateRevision',
    'activeReleaseId',
    'activeReleaseGeneration',
    'activeReleaseVersion',
    'activeReleaseCandidateHash',
    'identityPassTypeIdentifier',
    'identityTeamIdentifier',
    'identityRevision',
  ] as const)('rejects missing %s instead of substituting a fresh revision', async (field) => {
    const s = await scenario();
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate?.activeTemplateVersion) throw new Error('Missing active candidate');
    const snapshot = { ...candidate, [field]: null };
    expect(await foundOf(kit.ctx, snapshot, s.actor)).toBeNull();
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        snapshot.pass,
        snapshot.connectionGeneration,
        snapshot.activeTemplateVersion,
        snapshot.orgRevision,
        snapshot.templateRevision,
        kit.clock.now(),
        snapshot,
      ),
    ).toBe(false);
    expect(
      await passSnapshotFence(
        kit.env.DB,
        snapshot.pass,
        snapshot.checkInRules,
        snapshot.connectionGeneration,
        snapshot.activeTemplateVersion,
        snapshot.orgRevision,
        snapshot.templateRevision,
        kit.clock.now(),
        kit.env,
        snapshot,
      ),
    ).toBeNull();
    await expect(
      mintAssetGrant(
        kit.ctx,
        s.actor,
        snapshot,
        snapshot.connectionGeneration,
        candidate.activeTemplateVersion,
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('does not substitute an approved release from another mode', async () => {
    const s = await scenario();
    const testPass = await kit.scanPass(s.templateId, {}, { mode: 'test' });
    const live = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    const test = await candidateById(kit.env.DB, kit.org.id, testPass.id);
    if (!live?.activeTemplateVersion || !test?.activeReleaseId)
      throw new Error('Missing scoped releases');
    expect(test.activeReleaseId).not.toBe(live.activeReleaseId);
    const wrongScope = {
      ...live,
      activeReleaseId: test.activeReleaseId,
      activeReleaseGeneration: test.activeReleaseGeneration,
      activeReleaseVersion: test.activeReleaseVersion,
      activeReleaseCandidateHash: test.activeReleaseCandidateHash,
    };
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        live.pass,
        live.connectionGeneration,
        live.activeTemplateVersion,
        live.orgRevision,
        live.templateRevision,
        kit.clock.now(),
        live,
      ),
    ).toBe(true);
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        live.pass,
        live.connectionGeneration,
        live.activeTemplateVersion,
        live.orgRevision,
        live.templateRevision,
        kit.clock.now(),
        wrongScope,
      ),
    ).toBe(false);
    expect(
      await passSnapshotFence(
        kit.env.DB,
        live.pass,
        live.checkInRules,
        live.connectionGeneration,
        live.activeTemplateVersion,
        live.orgRevision,
        live.templateRevision,
        kit.clock.now(),
        kit.env,
        wrongScope,
      ),
    ).toBeNull();
  });

  it.each([
    'activeReleaseId',
    'activeReleaseGeneration',
    'activeReleaseVersion',
    'activeReleaseCandidateHash',
  ] as const)('rejects a mismatched %s even with current policy revisions', async (field) => {
    const s = await scenario();
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate?.activeTemplateVersion) throw new Error('Missing scoped release');
    const changed = {
      ...candidate,
      [field]:
        field === 'activeReleaseGeneration' ? candidate.activeReleaseGeneration! + 1 : 'different',
    };
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        candidate.pass,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        changed,
      ),
    ).toBe(false);
    expect(
      await passSnapshotFence(
        kit.env.DB,
        candidate.pass,
        candidate.checkInRules,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        kit.env,
        changed,
      ),
    ).toBeNull();
  });

  it('isolates release supersession between live and test pass snapshots', async () => {
    const s = await scenario();
    const testPass = await kit.scanPass(s.templateId, {}, { mode: 'test' });
    const live = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    const test = await candidateById(kit.env.DB, kit.org.id, testPass.id);
    if (!live?.activeTemplateVersion || !test?.activeReleaseVersion)
      throw new Error('Missing scoped releases');
    await approveAppleRelease(kit, {
      templateId: s.templateId,
      mode: 'test',
      version: test.activeReleaseVersion,
    });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        live.pass,
        live.connectionGeneration,
        live.activeTemplateVersion,
        live.orgRevision,
        live.templateRevision,
        kit.clock.now(),
        live,
      ),
    ).toBe(true);
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        test.pass,
        test.connectionGeneration,
        test.activeTemplateVersion,
        test.orgRevision,
        test.templateRevision,
        kit.clock.now(),
        test,
      ),
    ).toBe(false);
    const refreshedTest = await candidateById(kit.env.DB, kit.org.id, testPass.id);
    if (!refreshedTest?.activeTemplateVersion) throw new Error('Missing refreshed test release');
    await approveAppleRelease(kit, {
      templateId: s.templateId,
      mode: 'live',
      version: live.activeTemplateVersion,
    });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        refreshedTest.pass,
        refreshedTest.connectionGeneration,
        refreshedTest.activeTemplateVersion,
        refreshedTest.orgRevision,
        refreshedTest.templateRevision,
        kit.clock.now(),
        refreshedTest,
      ),
    ).toBe(true);
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        live.pass,
        live.connectionGeneration,
        live.activeTemplateVersion,
        live.orgRevision,
        live.templateRevision,
        kit.clock.now(),
        live,
      ),
    ).toBe(false);
  });

  for (const policy of ['organization', 'template'] as const) {
    for (const route of ['resolve', 'lookup', 'actions'] as const) {
      it(`does not expose or act on a candidate after a ${policy} ABA in ${route}`, async () => {
        const s = await scenario();
        const response = await afterCandidateRead(
          s.pass.id,
          (db) => changeAwayAndBack(db, policy, s.templateId),
          () =>
            kit.post(
              s.scanner.headers,
              `/${route}`,
              route === 'lookup'
                ? { q: s.pass.id }
                : { ...requestOf(s.pass.id), ...(route === 'actions' ? { actionId: 'auto' } : {}) },
            ),
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain(s.pass.id);
        expect(text).not.toContain('Revision Private Person');
        if (route === 'lookup') expect(JSON.parse(text)).toEqual({ items: [], more: false });
        else
          expect(JSON.parse(text)).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            card: null,
            display: null,
          });
        expect(
          await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
        ).toHaveLength(0);
        expect(
          await all(
            kit.env.DB,
            "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
            [s.pass.id],
          ),
        ).toHaveLength(0);
      });
    }

    for (const kind of ['inactive', 'mode mismatch'] as const) {
      for (const route of ['resolve', 'actions'] as const) {
        it(`does not disclose or commit a ${kind} stop after a ${policy} ABA in ${route}`, async () => {
          const s = await scenario(kind === 'mode mismatch' ? 'test' : 'live');
          if (kind === 'inactive')
            await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [s.pass.id]);
          const response = await afterCandidateRead(
            s.pass.id,
            (db) => changeAwayAndBack(db, policy, s.templateId),
            () =>
              kit.post(s.scanner.headers, `/${route}`, {
                ...requestOf(s.pass.id),
                ...(route === 'actions' ? { actionId: 'auto' } : {}),
              }),
          );
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(JSON.parse(text)).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            card: null,
            display: null,
          });
          expect(text).not.toContain(s.pass.id);
          expect(
            await all(
              kit.env.DB,
              "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
              [s.pass.id],
            ),
          ).toHaveLength(0);
        });
      }
    }

    for (const phase of ['before', 'after'] as const) {
      it(`${phase === 'before' ? 'blocks the gate' : 'withholds output'} after a ${policy} ABA ${phase} commit`, async () => {
        const s = await scenario();
        const request = { ...requestOf(s.pass.id), actionId: 'auto' };
        const response = await atGate(
          phase,
          (db) => changeAwayAndBack(db, policy, s.templateId),
          () => kit.post(s.scanner.headers, '/actions', request),
        );
        const text = await response.text();
        expect(text).not.toContain(s.pass.id);
        expect(text).not.toContain('Revision Private Person');
        const gates = await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [
          s.pass.id,
        ]);
        const ledger = await all(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
          [s.pass.id],
        );
        if (phase === 'before') {
          expect(response.status).toBe(200);
          expect(JSON.parse(text)).toMatchObject({ kind: 'refused', reason: 'not_found' });
          expect(gates).toHaveLength(0);
          expect(ledger).toHaveLength(0);
        } else {
          expect(response.status).toBe(409);
          expect(JSON.parse(text)).toMatchObject({ code: 'SCAN_UNCONFIRMED' });
          expect(gates).toHaveLength(1);
          expect(ledger).toHaveLength(1);
        }
      });
    }
  }
});
