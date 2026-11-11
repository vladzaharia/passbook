import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, afterCandidateRead, atGate, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner evaluated policy revisions', () => {
  for (const route of ['resolve', 'lookup', 'actions'] as const) {
    it(`does not disclose a candidate after a same-version release supersedes it in ${route}`, async () => {
      const s = await scenario('test', 'test');
      const snapshot = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!snapshot?.activeReleaseVersion) throw new Error('Missing release');
      const response = await afterCandidateRead(
        s.pass.id,
        async (db) => {
          await approveAppleRelease(kit, {
            db,
            templateId: s.templateId,
            mode: 'test',
            version: snapshot.activeReleaseVersion!,
          });
        },
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
          display: null,
        });
      const current = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      expect(current).toMatchObject({
        activeTemplateVersion: snapshot.activeTemplateVersion,
        orgRevision: snapshot.orgRevision,
        templateRevision: snapshot.templateRevision,
      });
      expect(current?.activeReleaseId).not.toBe(snapshot.activeReleaseId);
      expect(
        await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
      ).toHaveLength(0);
      expect(
        await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
          s.pass.id,
        ]),
      ).toHaveLength(0);
    });
  }

  for (const kind of ['inactive', 'mode mismatch'] as const) {
    for (const route of ['resolve', 'actions'] as const) {
      it(`does not disclose or record a ${kind} stop after release supersession in ${route}`, async () => {
        const mode = 'test' as const;
        const s = await scenario(mode, kind === 'mode mismatch' ? 'live' : mode);
        if (kind === 'inactive')
          await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [s.pass.id]);
        const snapshot = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
        if (!snapshot?.activeReleaseVersion) throw new Error('Missing release');
        const response = await afterCandidateRead(
          s.pass.id,
          async (db) => {
            await approveAppleRelease(kit, {
              db,
              templateId: s.templateId,
              mode,
              version: snapshot.activeReleaseVersion!,
            });
          },
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
          display: null,
        });
        expect(text).not.toContain(s.pass.id);
        const current = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
        expect(current).toMatchObject({
          activeTemplateVersion: snapshot.activeTemplateVersion,
          orgRevision: snapshot.orgRevision,
          templateRevision: snapshot.templateRevision,
        });
        expect(current?.activeReleaseId).not.toBe(snapshot.activeReleaseId);
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
    it(`${phase === 'before' ? 'blocks admission' : 'withholds output'} after release supersession`, async () => {
      const s = await scenario('test', 'test');
      const snapshot = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!snapshot?.activeReleaseVersion) throw new Error('Missing release');
      const response = await atGate(
        phase,
        async (db) => {
          await approveAppleRelease(kit, {
            db,
            templateId: s.templateId,
            mode: 'test',
            version: snapshot.activeReleaseVersion!,
          });
        },
        () =>
          kit.post(s.scanner.headers, '/actions', { ...requestOf(s.pass.id), actionId: 'auto' }),
      );
      const text = await response.text();
      expect(text).not.toContain(s.pass.id);
      expect(text).not.toContain('Revision Private Person');
      const current = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      expect(current).toMatchObject({
        activeTemplateVersion: snapshot.activeTemplateVersion,
        orgRevision: snapshot.orgRevision,
        templateRevision: snapshot.templateRevision,
      });
      expect(current?.activeReleaseId).not.toBe(snapshot.activeReleaseId);
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
});
