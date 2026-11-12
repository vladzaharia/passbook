import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import {
  ACTION,
  action,
  body,
  fixture,
  PRIVATE,
  race,
  stageVersion,
} from './action-template-read-race-test-fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { buildDisplay } from './display.ts';
import { projectScanInputs, scanInputVisible } from './projection-privacy.ts';
import { effects } from './repo-action-template-read-race-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';
import { makeLegacyScanPass, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('action policy from captured D1 template rows', () => {
  it('intersects two valid incompatible policies without revealing either denied source', async () => {
    const seedId = await kit.scanTemplate('Policy source', { actions: [ACTION] });
    const seed = await kit.registry.resolve(seedId, 'v1');
    const templateId = `${seedId}-policy`;
    const manifest = structuredClone(seed.manifest);
    manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'hidden' };
    const pinned = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v1',
      manifest,
      passJson: seed.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, pinned, { registry: kit.registry, buildKey: 'pinned-build' });
    await approveAppleRelease(kit, { templateId, version: 'v1', mode: 'live' });
    const pass = await kit.scanPass(templateId, {
      memberName: 'Hidden Current Holder',
      tier: 'Hidden Pinned Tier',
      memberNo: 'PUBLIC-PASS',
    });
    await putMemberPhoto(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      {
        png: btoa(String.fromCharCode(...makePng(270, 270))),
        includeInPass: true,
      },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [templateId] });
    await stageVersion(
      kit,
      templateId,
      'v2',
      (current) => {
        current.inputs.properties!.tier = { type: 'string' };
        current.inputs.properties!.memberName = { type: 'string', 'x-scan': 'hidden' };
        current.scan!.actions = [{ ...ACTION, minRole: 'manager' }];
      },
      'incompatible-build',
    );
    await approveAppleRelease(kit, { templateId, version: 'v2', mode: 'live' });
    const actor = await assetActorFor(kit, scanner);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing D1 candidate');
    expect(candidate.displayTemplateVersion).toBeNull();
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Expected captured incompatible policies');
    expect(found).toMatchObject({
      template: { version: 'v1' },
      activeTemplate: { version: 'v1' },
      activePolicy: { version: 'v2' },
      scan: { actions: [{ id: ACTION.id, minRole: 'manager' }] },
    });
    expect(scanInputVisible(found, actor, 'tier')).toBe(false);
    expect(scanInputVisible(found, actor, 'memberName')).toBe(false);
    expect(projectScanInputs(found, actor)).toMatchObject({ memberNo: 'PUBLIC-PASS' });
    const display = buildDisplay(kit.ctx, {
      actor,
      template: found,
      pass: { id: pass.id, title: 'Hidden Current Holder' },
      screen: 'ready',
    });
    for (const value of ['Hidden Current Holder', 'Hidden Pinned Tier'])
      expect(JSON.stringify(display)).not.toContain(value);
    // Policy comes from the head whatever its build: the door scanner may not run the manager-only
    // action, so it asks for approval and records nothing; neither hidden source is shown.
    const result = await action(kit, scanner.headers, body(kit, pass.id));
    expect(result).toMatchObject({
      kind: 'heads_up',
      reason: 'needs_approval',
      scanId: null,
      action: null,
      card: null,
    });
    for (const value of ['Hidden Current Holder', 'Hidden Pinned Tier', 'assetGrant'])
      expect(JSON.stringify(result)).not.toContain(value);
    // The member photo has its own policy (door), as for a compatible head; only it names the pass.
    const headsUpPhoto = result.display?.identity.photo?.url ?? '';
    expect(headsUpPhoto).toContain(`/passes/${pass.id}/assets/member.png?g=`);
    expect(JSON.stringify(result).replace(headsUpPhoto, '')).not.toContain(pass.id);
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toBeNull();
    const chooser = await kit.scanner({ templateIds: [templateId], settings: { flow: 'choose' } });
    const ready = await action(kit, chooser.headers, body(kit, pass.id));
    expect(ready).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    if (!ready.card) throw new Error('Expected an incompatible-head read card');
    // The member photo is read under the pass's own release, as on the resolve card.
    const photoUrl = ready.card.display.identity.photo?.url;
    if (!photoUrl) throw new Error('Photo withheld under the incompatible head');
    expect((await kit.get(chooser.headers, photoUrl.replace('/api/v1/scan', ''))).status).toBe(200);
    expect(ready.card.passView.assetNames).not.toContain('thumbnail@3x.png');
    for (const value of ['Hidden Current Holder', 'Hidden Pinned Tier'])
      expect(JSON.stringify(ready)).not.toContain(value);
    const base = ready.card.passView.assetBaseUrl.replace('/api/v1/scan', '');
    const token = encodeURIComponent(ready.card.passView.assetGrant);
    expect((await kit.get(chooser.headers, `${base}icon.png?g=${token}`)).status).toBe(200);
    expect((await kit.get(chooser.headers, `${base}member.png?g=${token}`)).status).toBe(404);
    expect((await kit.get(chooser.headers, `${base}thumbnail@3x.png?g=${token}`)).status).toBe(404);
  });

  it('allows the unchanged legacy pin and admits the first approved head at commit', async () => {
    const valid = await fixture(kit, { legacy: true });
    const candidate = await candidateById(kit.env.DB, kit.org.id, valid.pass.id);
    expect(candidate).toMatchObject({
      pass: { releaseId: null },
      activeReleaseId: null,
      activeTemplateVersion: 'v1',
      displayTemplateVersion: 'v1',
    });
    expect((await action(kit, valid.scanner.headers, body(kit, valid.pass.id))).kind).toBe('ok');

    const stale = await fixture(kit, { legacy: true });
    const request = body(kit, stale.pass.id);
    const before = await effects(kit.env.DB, stale.pass.id, request.idempotencyKey, kit.org.id);
    const result = await race(kit, stale.scanner.headers, request, 'INSERT INTO scan_gates', (db) =>
      approveAppleRelease(kit, { db, templateId: stale.templateId, version: 'v1', mode: 'live' }),
    );
    // The first approved head is a release (content), not authority: the visit is recorded.
    expect(result.kind).toBe('ok');
    expect(
      await effects(kit.env.DB, stale.pass.id, request.idempotencyKey, kit.org.id),
    ).toMatchObject({ gates: 1, events: 1 });
    expect(before).toMatchObject({ gates: 0, events: 0 });
    expect((await candidateById(kit.env.DB, kit.org.id, stale.pass.id))?.activeReleaseId).toEqual(
      expect.any(String),
    );
  });

  it.each(['null action', 'bad role', 'malformed flag'] as const)(
    'does not disclose a card when the approved active D1 row contains a %s',
    async (kind) => {
      const f = await fixture(kit, { choose: true });
      await stageVersion(kit, f.templateId, 'v2', (manifest) => {
        const scan = manifest.scan as unknown as Record<string, unknown>;
        if (kind === 'null action') scan.actions = [null];
        if (kind === 'bad role') scan.actions = [{ ...ACTION, minRole: 'root' }];
        if (kind === 'malformed flag') scan.flags = [null];
      });
      await approveAppleRelease(kit, { templateId: f.templateId, version: 'v2', mode: 'live' });
      const current = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
      expect(current).toMatchObject({
        pass: { templateVersion: 'v1' },
        activeTemplateVersion: 'v2',
      });
      const before = await first(
        kit.env.DB,
        'SELECT count(*) AS n FROM scan_asset_grant_provenance WHERE org_id=?',
        [kit.org.id],
      );
      const result = await action(kit, f.scanner.headers, body(kit, f.pass.id));
      expect(result).toMatchObject({ kind: 'refused', card: null, display: null, template: null });
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
      expect(
        await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [f.pass.id]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
          [f.pass.id],
        ),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT count(*) AS n FROM scan_asset_grant_provenance WHERE org_id=?',
          [kit.org.id],
        ),
      ).toEqual(before);
    },
  );

  it.each(['actions object', 'null action', 'bad role', 'malformed flag'] as const)(
    'fails closed on a legacy template with %s in the actual D1 row',
    async (kind) => {
      const templateId = await kit.scanTemplate(
        'Malformed old template',
        { actions: [ACTION] },
        { releaseModes: [] },
      );
      const original = await kit.registry.resolve(templateId, 'v1');
      const manifest = structuredClone(original.manifest) as unknown as Record<string, unknown>;
      const scan = { ...original.manifest.scan } as Record<string, unknown>;
      if (kind === 'actions object') scan.actions = {};
      if (kind === 'null action') scan.actions = [null];
      if (kind === 'bad role') scan.actions = [{ ...ACTION, minRole: 'root' }];
      if (kind === 'malformed flag') scan.flags = [null];
      manifest.scan = scan;
      const bad = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version: 'bad',
        manifest: manifest as unknown as TemplateManifest,
        passJson: original.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, bad, { registry: kit.registry });
      const pass = await makeLegacyScanPass(kit.fx, {
        orgId: kit.org.id,
        template: bad,
        personalization: { memberName: 'Malformed Private Holder' },
      });
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const request = body(kit, pass.id);
      const result = await action(kit, scanner.headers, request);
      expect(result.kind).toBe('refused');
      expect(result.card).toBeNull();
      expect(result.display).toBeNull();
      expect(JSON.stringify(result)).not.toContain('Malformed Private Holder');
      expect(
        await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
          [pass.id],
        ),
      ).toBeNull();
    },
  );
});
