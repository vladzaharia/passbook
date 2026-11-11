import { beforeAll, describe, expect, it } from 'vitest';
import { makePass, materializeTemplateAssets } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { actionPassFence, passSnapshotCurrent } from './repo-pass-authority.ts';
import { CHECK_IN, policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { persistLegacyWallet, afterCandidateRead, atGate, requestOf } = policyRevisionHelpers(
  () => kit,
);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner evaluated policy revisions', () => {
  it('retains a proven pinned legacy receipt when its first approved head appears', async () => {
    const templateId = await kit.scanTemplate(
      'Legacy release',
      { actions: [CHECK_IN] },
      { releaseModes: ['test'] },
    );
    const template = await kit.registry.resolve(templateId);
    const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
    await persistLegacyWallet(pass, template.passJson);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing legacy pass');
    expect(candidate).toMatchObject({
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
      activeTemplateVersion: template.version,
      pass: { releaseId: null },
    });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        candidate.pass,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        candidate,
      ),
    ).toBe(true);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const request = { ...requestOf(pass.id), actionId: 'auto' };
    const response = await kit.post(scanner.headers, '/actions', request);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { kind: string; scanId: string | null };
    expect(result).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    const ledger = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
      [pass.id],
    );
    expect(JSON.parse(ledger!.data).authority).toMatchObject({
      pinnedReleaseId: null,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    });
    await approveAppleRelease(kit, { templateId, mode: 'live', version: template.version });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        candidate.pass,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        candidate,
      ),
    ).toBe(false);
    const fresh = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!fresh) throw new Error('Missing approved candidate');
    expect(fresh.activeReleaseId).toEqual(expect.any(String));
    expect(
      await actionPassFence(
        kit.env.DB,
        fresh.pass,
        fresh.checkInRules,
        fresh.connectionGeneration,
        fresh.activeTemplateVersion,
        fresh.orgRevision,
        fresh.templateRevision,
        kit.clock.now(),
        kit.env,
        fresh,
      ),
    ).not.toBeNull();
    const replay = await kit.post(scanner.headers, '/actions', request);
    expect(await replay.json()).toMatchObject({ kind: 'ok', scanId: result.scanId, replay: true });
  });

  it.each([true, false])(
    'fences a legacy pass against a newer approved build (compatible=%s)',
    async (compatible) => {
      const baseId = await kit.scanTemplate(
        'Legacy build base',
        { actions: [CHECK_IN] },
        { releaseModes: [] },
      );
      const base = await kit.registry.resolve(baseId);
      const templateId = `legacy-build-${kit.fx.ids.id()}`;
      const pinned = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version: 'v1',
        manifest: base.manifest,
        passJson: base.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await run(
        kit.env.DB,
        `INSERT INTO templates
      (id,org_id,slug,name,origin,active_version,created_at,updated_at) VALUES (?,?,?,?,'uploaded',?,?,?)`,
        [
          templateId,
          kit.org.id,
          templateId,
          pinned.manifest.name,
          pinned.version,
          kit.clock.now(),
          kit.clock.now(),
        ],
      );
      const pinnedAssets = await materializeTemplateAssets(kit.fx, pinned, kit.registry);
      await run(
        kit.env.DB,
        `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,created_at,build_key) VALUES (?,?,?,?,?,?,?)`,
        [
          templateId,
          pinned.version,
          JSON.stringify(pinned.manifest),
          JSON.stringify(pinned.passJson),
          JSON.stringify(pinnedAssets),
          kit.clock.now(),
          'pinned-build',
        ],
      );
      const pass = await makePass(kit.fx, { orgId: kit.org.id, template: pinned });
      await persistLegacyWallet(pass, pinned.passJson);
      const active = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version: 'v2',
        manifest: pinned.manifest,
        passJson: pinned.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      const activeAssets = await materializeTemplateAssets(kit.fx, active, kit.registry);
      await run(
        kit.env.DB,
        `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,created_at,build_key) VALUES (?,?,?,?,?,?,?)`,
        [
          templateId,
          active.version,
          JSON.stringify(active.manifest),
          JSON.stringify(active.passJson),
          JSON.stringify(activeAssets),
          kit.clock.now(),
          compatible ? 'pinned-build' : 'different-build',
        ],
      );
      await approveAppleRelease(kit, { templateId, mode: 'live', version: active.version });
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Missing legacy candidate');
      expect(candidate.pass.releaseId).toBeNull();
      expect(candidate.activeTemplateVersion).toBe(active.version);
      const fence = await actionPassFence(
        kit.env.DB,
        candidate.pass,
        candidate.checkInRules,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        kit.env,
        candidate,
      );
      if (compatible) expect(fence).not.toBeNull();
      else expect(fence).toBeNull();
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const response = await kit.post(scanner.headers, '/actions', {
        ...requestOf(pass.id),
        actionId: 'auto',
      });
      const result = await response.json();
      if (compatible) expect(result).toMatchObject({ kind: 'ok' });
      else {
        expect(result).toMatchObject({ kind: 'refused', reason: 'not_found' });
        expect(
          await all(
            kit.env.DB,
            "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
            [pass.id],
          ),
        ).toHaveLength(0);
      }
    },
  );

  it.each([false, true])('rejects a cross-mode issuance pin (active head=%s)', async (withHead) => {
    const templateId = await kit.scanTemplate(
      'Wrong release scope',
      { actions: [CHECK_IN] },
      { releaseModes: withHead ? ['live', 'test'] : ['test'] },
    );
    const template = await kit.registry.resolve(templateId);
    const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
    if (!withHead) {
      const legacy = await makePass(kit.fx, { orgId: kit.org.id, template });
      await persistLegacyWallet(legacy, template.passJson);
    }
    const testRelease = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM template_releases WHERE template_id=? AND org_id=? AND mode='test' AND provider='apple' ORDER BY generation DESC LIMIT 1",
      [templateId, kit.org.id],
    );
    if (!testRelease) throw new Error('Missing test release');
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [testRelease.id, pass.id]);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate).toBeNull();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await kit.post(scanner.headers, '/actions', {
      ...requestOf(pass.id),
      actionId: 'auto',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      display: null,
    });
    expect(
      await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('does not commit a legacy scan if an approved head appears after evaluation', async () => {
    const templateId = await kit.scanTemplate(
      'Legacy release race',
      { actions: [CHECK_IN] },
      { releaseModes: ['test'] },
    );
    const template = await kit.registry.resolve(templateId);
    const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
    await persistLegacyWallet(pass, template.passJson);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await afterCandidateRead(
      pass.id,
      async (db) => {
        await approveAppleRelease(kit, { db, templateId, mode: 'live', version: template.version });
      },
      () => kit.post(scanner.headers, '/actions', { ...requestOf(pass.id), actionId: 'auto' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      display: null,
    });
    expect(
      await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  for (const phase of ['before', 'after'] as const) {
    it(`${phase === 'before' ? 'blocks' : 'withholds'} a legacy action when its first head appears ${phase} the gate`, async () => {
      const templateId = await kit.scanTemplate(
        'Legacy gate race',
        { actions: [CHECK_IN] },
        { releaseModes: ['test'] },
      );
      const template = await kit.registry.resolve(templateId);
      const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
      await persistLegacyWallet(pass, template.passJson);
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const response = await atGate(
        phase,
        async (db) => {
          await approveAppleRelease(kit, {
            db,
            templateId,
            mode: 'live',
            version: template.version,
          });
        },
        () => kit.post(scanner.headers, '/actions', { ...requestOf(pass.id), actionId: 'auto' }),
      );
      const text = await response.text();
      expect(text).not.toContain(pass.id);
      const gates = await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [
        pass.id,
      ]);
      const ledger = await all(
        kit.env.DB,
        "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
        [pass.id],
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
