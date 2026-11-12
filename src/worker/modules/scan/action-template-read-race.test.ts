import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  ACTION,
  action,
  body,
  expectClassified,
  expectStopRecordedWithoutGrants,
  expectUnavailable,
  fixture,
  race,
  raceRaw,
  stageVersion,
} from './action-template-read-race-test-fixtures.ts';
import { effects } from './repo-action-template-read-race-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { makeLegacyScanPass, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

const marker = 'INTO scan_asset_grant_provenance';

/**
 * The scan grant asks no template or release state (authority-epochs.md F4): a change landing before
 * the commit is content. The visit is recorded; only the photo grant, bound to the read, is withheld.
 */
function expectGateRecordedWithoutGrants(result: ScanOutcome) {
  expect(result).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
  expect(result.display?.identity.photo?.url ?? null).toBeNull();
  expect(JSON.stringify(result)).not.toContain('assetGrant');
}

describe('captured action template reads at the final CAS', () => {
  it.each(['gate', 'choose', 'stop'] as const)(
    'confirms a normal %s result and photo from its captured template',
    async (phase) => {
      const f = await fixture(kit, {
        choose: phase === 'choose',
        stop: phase === 'stop',
        photo: true,
      });
      const request = body(kit, f.pass.id);
      const result = await action(kit, f.scanner.headers, request);
      expect(result.kind).toBe(phase === 'gate' ? 'ok' : phase === 'choose' ? 'ready' : 'heads_up');
      const photo =
        phase === 'choose' ? result.card?.display.identity.photo : result.display?.identity.photo;
      expect(photo?.url).toContain(`/passes/${f.pass.id}/assets/member.png?g=`);
      if (phase === 'choose') expect(result.card?.passView.assetGrant).toEqual(expect.any(String));
    },
  );

  for (const phase of ['gate', 'choose', 'stop'] as const) {
    for (const source of ['pinned', 'active'] as const) {
      it(`handles ${source} version replacement before the ${phase} transaction`, async () => {
        const f = await fixture(kit, {
          compatiblePin: true,
          choose: phase === 'choose',
          stop: phase === 'stop',
          photo: true,
        });
        await stageVersion(kit, f.templateId, 'v2', () => {}, 'same-build');
        if (source === 'active')
          await approveAppleRelease(kit, { templateId: f.templateId, version: 'v2', mode: 'live' });
        const original = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
        if (!original?.templateSnapshot) throw new Error('Missing captured template rows');
        expect(original.pass.templateVersion).toBe('v1');
        expect(original.activeTemplateVersion).toBe(source === 'active' ? 'v2' : 'v1');
        const request = body(kit, f.pass.id);
        const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
        let rejectedRewrite = false;
        const result = await race(kit, f.scanner.headers, request, marker, async (db) => {
          await expect(
            run(
              db,
              `UPDATE template_versions SET manifest=json_set(manifest,'$.name','rewritten')
            WHERE template_id=? AND version=?`,
              [f.templateId, source === 'active' ? 'v2' : 'v1'],
            ),
          ).rejects.toThrow(/template versions are immutable/);
          rejectedRewrite = true;
          if (source === 'pinned') {
            await run(db, 'UPDATE passes SET template_version=?, release_id=NULL WHERE id=?', [
              'v2',
              f.pass.id,
            ]);
          } else {
            await approveAppleRelease(kit, {
              db,
              templateId: f.templateId,
              version: 'v1',
              mode: 'live',
            });
          }
        });
        expect(rejectedRewrite).toBe(true);
        if (phase === 'stop') {
          expectStopRecordedWithoutGrants(result);
          expect(
            await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
          ).toMatchObject({ grants: before?.grants });
        } else if (phase === 'gate') {
          expectGateRecordedWithoutGrants(result);
          expect(
            await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
          ).toMatchObject({ gates: 1, events: 1, grants: before?.grants });
        } else {
          expectUnavailable(result, f.pass.id);
          expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
            before,
          );
        }
        const current = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
        expect(current?.templateSnapshot?.raw).not.toBe(original.templateSnapshot.raw);
        expect(
          source === 'pinned' ? current?.pass.templateVersion : current?.activeTemplateVersion,
        ).toBe(source === 'pinned' ? 'v2' : 'v1');
      });
    }
  }

  it('admits an actual late extra-row insertion against the original legacy pinned and active rows', async () => {
    const seedId = await kit.scanTemplate(
      'Old baked source',
      { actions: [ACTION] },
      { releaseModes: [] },
    );
    const seed = await kit.registry.resolve(seedId, 'v1');
    const templateId = `${seedId}-baked`;
    const template = kit.registry.add({
      id: templateId,
      orgId: null,
      origin: 'baked',
      version: 'v1',
      manifest: seed.manifest,
      passJson: seed.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const control = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    expect((await action(kit, scanner.headers, body(kit, control.id))).kind).toBe('ok');
    const original = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!original?.templateSnapshot) throw new Error('Missing legacy version snapshot');
    const captured = JSON.parse(original.templateSnapshot.raw) as {
      pinned: { extras: unknown[] };
      active: { extras: unknown[] };
    };
    expect(captured.pinned.extras).toEqual([]);
    expect(captured.active.extras).toEqual([]);
    const request = body(kit, pass.id);
    const result = await race(kit, scanner.headers, request, 'INSERT INTO scan_gates', (db) =>
      run(
        db,
        `INSERT INTO template_version_extras
        (template_id,version,name,size,sha1,sha256,r2_key) VALUES (?,?,?,?,?,?,?)`,
        [
          templateId,
          'v1',
          'preview.png',
          0,
          '1'.repeat(40),
          '2'.repeat(64),
          `legacy-extra/${templateId}`,
        ],
      ),
    );
    // Extra template files are content, not authority: the visit is recorded.
    expect(result.kind).toBe('ok');
    expect(await effects(kit.env.DB, pass.id, request.idempotencyKey, kit.org.id)).toMatchObject({
      gates: 1,
      events: 1,
    });
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current?.templateSnapshot) throw new Error('Missing current legacy version snapshot');
    const changed = JSON.parse(current.templateSnapshot.raw) as {
      pinned: { extras: { name: string }[] };
      active: { extras: { name: string }[] };
    };
    expect(changed.pinned.extras).toMatchObject([{ name: 'preview.png' }]);
    expect(changed.active.extras).toMatchObject([{ name: 'preview.png' }]);
  });

  // A card is a read and fails closed; a gate or stop commit keeps the policy it evaluated.
  it.each(['gate', 'choose', 'stop'] as const)(
    'withholds %s grants when a newly approved head tightens the captured policy',
    async (phase) => {
      const f = await fixture(kit, {
        compatiblePin: true,
        choose: phase === 'choose',
        stop: phase === 'stop',
        photo: true,
      });
      await stageVersion(
        kit,
        f.templateId,
        'v2',
        (manifest) => {
          manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'hidden' };
          manifest.scan!.actions = [{ ...ACTION, minRole: 'manager' }];
        },
        'same-build',
      );
      const request = body(kit, f.pass.id);
      const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
      const result = await race(kit, f.scanner.headers, request, marker, (db) =>
        approveAppleRelease(kit, { db, templateId: f.templateId, version: 'v2', mode: 'live' }),
      );
      if (phase === 'stop') {
        expectStopRecordedWithoutGrants(result);
        expect(
          await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
        ).toMatchObject({ grants: before?.grants });
      } else if (phase === 'gate') {
        expectGateRecordedWithoutGrants(result);
        expect(
          await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
        ).toMatchObject({ gates: 1, events: 1, grants: before?.grants });
      } else {
        expectUnavailable(result, f.pass.id);
        expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
          before,
        );
      }
      expect((await candidateById(kit.env.DB, kit.org.id, f.pass.id))?.activeTemplateVersion).toBe(
        'v2',
      );
    },
  );

  // Releases and archiving are content at commit; only a deleted template stops the pass.
  it.each(['same head', 'away and back', 'owner archived', 'owner deleted'] as const)(
    'commits or refuses by authority after %s between evaluation and gate',
    async (change) => {
      const f = await fixture(kit, { compatiblePin: true, photo: true });
      await stageVersion(kit, f.templateId, 'v2', () => {}, 'same-build');
      const original = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
      if (!original?.templateSnapshot) throw new Error('Missing captured template');
      const request = body(kit, f.pass.id);
      const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
      const response = await raceRaw(
        kit,
        f.scanner.headers,
        request,
        'INSERT INTO scan_gates',
        async (db) => {
          if (change === 'owner archived' || change === 'owner deleted') {
            await run(db, 'UPDATE templates SET status=?,updated_at=updated_at+1 WHERE id=?', [
              change === 'owner archived' ? 'archived' : 'deleted',
              f.templateId,
            ]);
          } else {
            if (change === 'away and back')
              await approveAppleRelease(kit, {
                db,
                templateId: f.templateId,
                version: 'v2',
                mode: 'live',
              });
            await approveAppleRelease(kit, {
              db,
              templateId: f.templateId,
              version: 'v1',
              mode: 'live',
            });
          }
        },
      );
      if (change === 'owner deleted') {
        await expectClassified(response, 'SCAN_PASS_CHANGED');
        expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
          before,
        );
        return;
      }
      expect(response.status).toBe(200);
      expect(ScanOutcomeSchema.parse(await response.json())).toMatchObject({
        kind: 'ok',
        scanId: expect.any(String),
      });
      expect(
        await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
      ).toMatchObject({ gates: 1, events: 1 });
      if (change === 'owner archived') {
        expect(
          await first(kit.env.DB, 'SELECT status FROM templates WHERE id=?', [f.templateId]),
        ).toEqual({ status: 'archived' });
      } else {
        const current = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
        expect(current?.templateSnapshot?.raw).not.toBe(original.templateSnapshot.raw);
        expect(current?.activeTemplateVersion).toBe('v1');
        expect(current?.activeReleaseId).not.toBe(original.activeReleaseId);
      }
    },
  );
});
