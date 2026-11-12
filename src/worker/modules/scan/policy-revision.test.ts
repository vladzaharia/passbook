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
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

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

  // The candidate captures the org's epochs (access and config revision), not `updated_at` stamps.
  // An org suspended and restored moves its access revision; a template archived and restored is
  // not authority (archived templates keep scanning), so the original read stays current.
  it.each(['organization', 'template'] as const)(
    'fences the candidate read only when a %s ABA moves an epoch',
    async (policy) => {
      const s = await scenario();
      const snapshot = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!snapshot?.activeTemplateVersion) throw new Error('Missing active candidate');
      const version = snapshot.activeTemplateVersion;
      const org = await first<{ access_revision: number; config_revision: number }>(
        kit.env.DB,
        'SELECT access_revision, config_revision FROM orgs WHERE id=?',
        [kit.org.id],
      );
      expect(snapshot.orgRevision).toBe(org?.access_revision);
      expect(snapshot.templateRevision).toBe(org?.config_revision);
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
      expect(fresh.templateRevision).toBe(snapshot.templateRevision);
      if (policy === 'template') {
        expect(fresh.orgRevision).toBe(snapshot.orgRevision);
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
        ).not.toBeNull();
        expect(
          (await kit.get(s.scanner.headers, `${assetPath}${encodeURIComponent(grant)}`)).status,
        ).toBe(200);
        return;
      }
      expect(fresh.orgRevision).toBe(snapshot.orgRevision! + 2);
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
    const own = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!own?.activeTemplateVersion) throw new Error('Missing scoped release');
    const version = own.activeTemplateVersion;
    const current = (c: NonNullable<typeof own>) =>
      passSnapshotCurrent(
        kit.env.DB,
        c.pass,
        c.connectionGeneration,
        c.activeTemplateVersion,
        c.orgRevision,
        c.templateRevision,
        kit.clock.now(),
        c,
      );
    const approve = (mode: 'live' | 'test') =>
      approveAppleRelease(kit, { templateId: s.templateId, mode, version });
    // A newer release does not invalidate a pass read under its own issued release.
    await approve('live');
    await approve('test');
    expect(await current(own)).toBe(true);
    // Read again, each pass's policy is bound to its own mode's head.
    const live = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    const test = await candidateById(kit.env.DB, kit.org.id, testPass.id);
    if (!live || !test) throw new Error('Missing head-bound candidates');
    expect(live.activeReleaseId).not.toBe(live.pass.releaseId);
    expect(test.activeReleaseId).not.toBe(test.pass.releaseId);
    expect(await current(live)).toBe(true);
    expect(await current(test)).toBe(true);
    await approve('test');
    expect(await current(live)).toBe(true);
    expect(await current(test)).toBe(false);
    const refreshedTest = await candidateById(kit.env.DB, kit.org.id, testPass.id);
    if (!refreshedTest) throw new Error('Missing refreshed test release');
    await approve('live');
    expect(await current(refreshedTest)).toBe(true);
    expect(await current(live)).toBe(false);
  });

  const ledgerOf = async (passId: string) => ({
    gates: (await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [passId]))
      .length,
    events: (
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
        passId,
      ])
    ).length,
  });
  const post = (s: Awaited<ReturnType<typeof scenario>>, route: string, idempotencyKey?: string) =>
    kit.post(
      s.scanner.headers,
      `/${route}`,
      route === 'lookup'
        ? { q: s.pass.id }
        : {
            ...requestOf(s.pass.id),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(route === 'actions' ? { actionId: 'auto' } : {}),
          },
    );
  /**
   * An action whose evaluated policy moved before its preflight is a race, not a miss: 409
   * `SCAN_IN_PROGRESS`, nothing disclosed or written, and the same key retried decides afresh.
   */
  const expectRaced = async (s: Awaited<ReturnType<typeof scenario>>, response: Response) => {
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(s.pass.id);
    expect(text).not.toContain('Revision Private Person');
    expect(JSON.parse(text)).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
    expect(await ledgerOf(s.pass.id)).toEqual({ gates: 0, events: 0 });
  };

  // Suspending and restoring the org moves its access revision: the read fences refuse the original
  // read. The scanner's own access never lapsed (the org is active again), so an action is retried.
  for (const route of ['resolve', 'lookup', 'actions'] as const) {
    it(`does not expose or act on a candidate after an organization ABA in ${route}`, async () => {
      const s = await scenario();
      const idempotencyKey = key();
      const response = await afterCandidateRead(
        s.pass.id,
        (db) => changeAwayAndBack(db, 'organization', s.templateId),
        () => post(s, route, idempotencyKey),
      );
      if (route === 'actions') {
        await expectRaced(s, response);
        const retry = await post(s, route, idempotencyKey);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ kind: 'ok' });
        expect(await ledgerOf(s.pass.id)).toEqual({ gates: 1, events: 1 });
        return;
      }
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
      expect(await ledgerOf(s.pass.id)).toEqual({ gates: 0, events: 0 });
    });
  }

  // Archiving and restoring the template moves no epoch, and archived templates keep scanning.
  for (const route of ['resolve', 'lookup', 'actions'] as const) {
    it(`exposes and acts on a candidate after a template ABA in ${route}`, async () => {
      const s = await scenario();
      const response = await afterCandidateRead(
        s.pass.id,
        (db) => changeAwayAndBack(db, 'template', s.templateId),
        () => post(s, route),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items?: unknown[]; kind?: string };
      if (route === 'lookup') expect(body.items).toMatchObject([{ passId: s.pass.id }]);
      else expect(body).toMatchObject({ kind: route === 'resolve' ? 'ready' : 'ok' });
      expect(await ledgerOf(s.pass.id)).toEqual(
        route === 'actions' ? { gates: 1, events: 1 } : { gates: 0, events: 0 },
      );
    });
  }

  for (const policy of ['organization', 'template'] as const) {
    for (const kind of ['inactive', 'mode mismatch'] as const) {
      for (const route of ['resolve', 'actions'] as const) {
        it(`does not disclose or commit a ${kind} stop after a ${policy} ABA in ${route}`, async () => {
          const s = await scenario(kind === 'mode mismatch' ? 'test' : 'live');
          if (kind === 'inactive')
            await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [s.pass.id]);
          const idempotencyKey = key();
          const response = await afterCandidateRead(
            s.pass.id,
            (db) => changeAwayAndBack(db, policy, s.templateId),
            () => post(s, route, idempotencyKey),
          );
          // An action on a voided pass under a moved org policy is retried, and the retry refuses it.
          if (route === 'actions' && kind === 'inactive' && policy === 'organization') {
            await expectRaced(s, response);
            const retry = await post(s, route, idempotencyKey);
            expect(retry.status).toBe(200);
            const retried = await retry.text();
            expect(JSON.parse(retried)).toMatchObject({ kind: 'refused', reason: 'voided' });
            expect(retried).not.toContain('Revision Private Person');
            expect(await ledgerOf(s.pass.id)).toEqual({ gates: 0, events: 1 });
            return;
          }
          expect(response.status).toBe(200);
          const text = await response.text();
          // Cross-mode detection is a bare refusal; a voided pass under an unchanged org is refused as such.
          const reason =
            kind === 'mode mismatch'
              ? 'test_pass'
              : policy === 'organization'
                ? 'not_found'
                : 'voided';
          expect(JSON.parse(text)).toMatchObject({
            kind: 'refused',
            reason,
            card: null,
            display: null,
          });
          expect(text).not.toContain(s.pass.id);
          expect(text).not.toContain('Revision Private Person');
          // An action on a pass that resolved is a fact: its refusal is logged, as without the ABA.
          const events = route === 'actions' && reason === 'voided' ? 1 : 0;
          expect(await ledgerOf(s.pass.id)).toEqual({ gates: 0, events });
        });
      }
    }

    // The scan grant checks a scanner's org by its status at commit (authority-epochs.md F5), and a
    // template's status is not authority; the commit is a fact and its result is returned.
    for (const phase of ['before', 'after'] as const) {
      it(`commits through a ${policy} ABA ${phase} the gate`, async () => {
        const s = await scenario();
        const request = { ...requestOf(s.pass.id), actionId: 'auto' };
        const response = await atGate(
          phase,
          (db) => changeAwayAndBack(db, policy, s.templateId),
          () => kit.post(s.scanner.headers, '/actions', request),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
        expect(await ledgerOf(s.pass.id)).toEqual({ gates: 1, events: 1 });
      });
    }
  }

  it('refuses the gate when the organization is suspended before commit', async () => {
    const s = await scenario();
    const request = { ...requestOf(s.pass.id), actionId: 'auto' };
    const response = await atGate(
      'before',
      (db) => run(db, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]).then(() => {}),
      () => kit.post(s.scanner.headers, '/actions', request),
    );
    try {
      const text = await response.text();
      expect(`${response.status} ${(JSON.parse(text) as { code?: string }).code}`).toBe(
        '403 ORG_ACCESS_CHANGED',
      );
      expect(text).not.toContain('Revision Private Person');
      expect(await ledgerOf(s.pass.id)).toEqual({ gates: 0, events: 0 });
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status='active' WHERE id=?", [kit.org.id]);
    }
  });
});
