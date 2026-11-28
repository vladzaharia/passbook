import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  ACTION,
  action,
  body,
  COMMIT_MARKER,
  expectClassified,
  expectGrantsUnredeemable,
  expectUnconfirmed,
  fixture,
  race,
  raceRaw,
  stageVersion,
} from './action-template-read-race-test-fixtures.ts';
import { RACE_PASS_FENCE } from './race-tags.ts';
import { effects } from './repo-action-template-read-race-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { makeLegacyScanPass, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

/**
 * The gate commit asks no template or release state (authority-epochs.md F4): a change landing before
 * it is content, the visit is recorded and its capabilities, minted from the read, no longer redeem.
 * A choose card or a stop answer is read under the snapshot: the commit's after-read finds it gone and
 * the answer is withheld (409 SCAN_UNCONFIRMED).
 */
async function expectRaced(
  phase: 'gate' | 'choose' | 'stop',
  headers: Record<string, string>,
  response: Response,
  headChanged = false,
) {
  if (phase !== 'gate') return expectUnconfirmed(response);
  // A head that says something else is the release gate of the check-in commit itself.
  if (headChanged) return expectClassified(response, 'SCAN_PASS_CHANGED');
  expect(response.status).toBe(200);
  const result = ScanOutcomeSchema.parse(await response.json());
  expect(result).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
  expect(await expectGrantsUnredeemable(kit, headers, result)).toBeGreaterThan(0);
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
      // Positive control for the races below: the same URL redeems when nothing moved.
      const served = await kit.get(f.scanner.headers, photo!.url!.replace('/api/v1/scan', ''));
      expect(served.status).toBe(200);
      await served.body?.cancel();
    },
  );

  for (const phase of ['gate', 'choose', 'stop'] as const) {
    // A pass repinned to another version of its template (a publish) is content, not authority: a
    // choose or stop answer read before it is still served. A head change is the release gate.
    for (const source of phase === 'gate'
      ? (['pinned', 'active'] as const)
      : (['active'] as const)) {
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
        let rejectedRewrite = false;
        const response = await raceRaw(
          kit,
          f.scanner.headers,
          request,
          COMMIT_MARKER[phase],
          async (db) => {
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
          },
        );
        expect(rejectedRewrite).toBe(true);
        await expectRaced(phase, f.scanner.headers, response, source === 'active');
        if (phase === 'gate')
          expect(
            await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
          ).toMatchObject(source === 'active' ? { gates: 0, events: 0 } : { gates: 1, events: 1 });
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

  it('answers 409 when a release-less legacy pass is repinned between evaluation and the preflight read', async () => {
    const seedId = await kit.scanTemplate(
      'Legacy repin source',
      { actions: [ACTION] },
      { releaseModes: [] },
    );
    const seed = await kit.registry.resolve(seedId, 'v1');
    const templateId = `${seedId}-repin`;
    const add = (version: string) =>
      kit.registry.add({
        id: templateId,
        orgId: null,
        origin: 'baked',
        version,
        manifest: seed.manifest,
        passJson: seed.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
    await persistTemplate(kit.fx, add('v1'), { registry: kit.registry });
    await persistTemplate(kit.fx, add('v2'), { registry: kit.registry });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const template = await kit.registry.resolve(templateId, 'v1');
    const control = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    expect((await action(kit, scanner.headers, body(kit, control.id))).kind).toBe('ok');
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const response = await raceRaw(
      kit,
      scanner.headers,
      body(kit, pass.id),
      RACE_PASS_FENCE,
      (db) => run(db, "UPDATE passes SET template_version='v2' WHERE id=?", [pass.id]),
    );
    // A race, not a miss: the client retries the same key.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
  });

  // A gate, stop or choose commit keeps the policy it evaluated; the capabilities it minted do not redeem.
  it.each(['gate', 'choose', 'stop'] as const)(
    'withholds a choose or stop answer, and voids the grants of a gate, when a newly approved head tightens the captured policy',
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
      const response = await raceRaw(kit, f.scanner.headers, request, COMMIT_MARKER[phase], (db) =>
        approveAppleRelease(kit, { db, templateId: f.templateId, version: 'v2', mode: 'live' }),
      );
      await expectRaced(phase, f.scanner.headers, response, true);
      if (phase === 'gate')
        expect(
          await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id),
        ).toMatchObject({ gates: 0, events: 0 });
      expect((await candidateById(kit.env.DB, kit.org.id, f.pass.id))?.activeTemplateVersion).toBe(
        'v2',
      );
    },
  );

  it('withholds an approval-needed answer when a newly approved head tightens the captured policy', async () => {
    const f = await fixture(kit, { compatiblePin: true, photo: true, minRole: 'manager' });
    await stageVersion(kit, f.templateId, 'v2', () => {}, 'same-build');
    // Positive control: with nothing moved the answer is a heads-up that offers the photo.
    const calm = await action(kit, f.scanner.headers, body(kit, f.pass.id));
    expect(calm.kind).toBe('heads_up');
    expect(calm.display?.identity.photo?.url ?? null).not.toBeNull();
    await expectUnconfirmed(
      await raceRaw(kit, f.scanner.headers, body(kit, f.pass.id), 'DELETE FROM scans', (db) =>
        approveAppleRelease(kit, { db, templateId: f.templateId, version: 'v2', mode: 'live' }),
      ),
    );
  });

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
        // A same-version head leaves the captured template unchanged: it is not counted.
        expect(current?.templateSnapshot?.raw).toBe(original.templateSnapshot.raw);
        expect(current?.activeTemplateVersion).toBe('v1');
        expect(current?.activeReleaseId).not.toBe(original.activeReleaseId);
      }
    },
  );
});
