import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { candidateById } from './repo-lookup.ts';
import { kit, search, setupLookupIdsFixture, templateId } from './repo-lookup-ids-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { approveScanReleases, key, makeLegacyScanPass, setPass } from './test-kit.ts';

beforeEach(setupLookupIdsFixture);

describe('scoped scanner release fixtures', () => {
  it('pins issuance and snapshots to separate Live and Test heads, then supersedes only Live', async () => {
    const livePass = await kit.scanPass(templateId);
    const testPass = await kit.scanPass(templateId, {}, { mode: 'test' });
    const live = await requireApprovedRelease(kit.ctx, templateId, kit.org.id, 'live', 'apple');
    const test = await requireApprovedRelease(kit.ctx, templateId, kit.org.id, 'test', 'apple');
    expect(live.id).not.toBe(test.id);

    for (const [pass, release] of [
      [livePass, live],
      [testPass, test],
    ] as const) {
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      expect(candidate).toMatchObject({
        activeReleaseId: release.id,
        activeReleaseGeneration: release.generation,
        activeReleaseVersion: release.version,
        activeReleaseCandidateHash: release.candidateHash,
        activeTemplateVersion: release.version,
      });
      if (!candidate) throw new Error('Missing approved candidate');
      for (const field of [
        'activeReleaseId',
        'activeReleaseGeneration',
        'activeReleaseVersion',
        'activeReleaseCandidateHash',
      ] as const) {
        expect(await foundOf(kit.ctx, { ...candidate, [field]: null })).toBeNull();
      }
      expect(await foundOf(kit.ctx, { ...candidate, activeReleaseGeneration: 0 })).toBeNull();
      expect(pass.templateVersion).toBe(release.version);
      expect(
        await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [pass.id]),
      ).toEqual({ release_id: release.id });
    }

    await approveScanReleases(kit, templateId, { version: live.version, modes: ['live'] });
    const next = await requireApprovedRelease(kit.ctx, templateId, kit.org.id, 'live', 'apple');
    expect(next.id).not.toBe(live.id);
    expect(next.generation).toBe(live.generation + 1);
    expect(next.version).toBe(live.version);
    expect(await candidateById(kit.env.DB, kit.org.id, livePass.id)).toMatchObject({
      activeReleaseId: next.id,
      activeReleaseGeneration: next.generation,
      activeReleaseVersion: next.version,
      activeReleaseCandidateHash: next.candidateHash,
      pass: { templateVersion: livePass.templateVersion },
    });
    expect(await candidateById(kit.env.DB, kit.org.id, testPass.id)).toMatchObject({
      activeReleaseId: test.id,
      activeReleaseGeneration: test.generation,
    });
  });

  it.each([{ releaseModes: [] }, { releaseModes: ['live'] }] as const)(
    'uses the immutable pinned version for a legacy Test pass without a Test head',
    async ({ releaseModes }) => {
      const templateId = await kit.scanTemplate(
        'Legacy Test lookup',
        {
          actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
        },
        { releaseModes },
      );
      await expect(kit.scanPass(templateId, {}, { mode: 'test' })).rejects.toMatchObject({
        code: 'TEMPLATE_RELEASE_REQUIRED',
      });

      const pinned = await kit.registry.resolve(templateId);
      const legacy = await makeLegacyScanPass(kit.fx, {
        orgId: kit.org.id,
        template: pinned,
        mode: 'test',
      });
      const draft = kit.registry.add({
        id: templateId,
        orgId: kit.org.id,
        version: 'unapproved-draft',
        manifest: { ...pinned.manifest, name: 'Unapproved draft' },
        passJson: pinned.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, draft, { registry: kit.registry });
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        draft.version,
        templateId,
      ]);

      const candidate = await candidateById(kit.env.DB, kit.org.id, legacy.id);
      expect(candidate).toMatchObject({
        activeReleaseId: null,
        activeReleaseGeneration: null,
        activeReleaseVersion: null,
        activeReleaseCandidateHash: null,
        activeTemplateVersion: pinned.version,
        displayTemplateVersion: pinned.version,
      });
      if (!candidate) throw new Error('Missing legacy candidate');
      expect(await foundOf(kit.ctx, candidate)).toMatchObject({
        activeVersion: pinned.version,
        template: { version: pinned.version },
      });
      const scanner = await kit.scanner({ mode: 'test', settings: { acceptAllTemplates: true } });
      expect((await search(legacy.id, scanner.headers)).items.map((item) => item.passId)).toEqual([
        legacy.id,
      ]);
      const response = await kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { passId: legacy.id, method: 'manual' },
        clientTs: kit.clock.now(),
      });
      expect(await response.json()).toMatchObject({ kind: 'ready', card: { passId: legacy.id } });
    },
  );

  it('does not use a Live release as a Test head for an already-released pass', async () => {
    const unapproved = await kit.scanTemplate(
      'Unapproved Test lookup',
      {
        actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
      },
      { releaseModes: ['live'] },
    );
    await expect(kit.scanPass(unapproved, {}, { mode: 'test' })).rejects.toMatchObject({
      code: 'TEMPLATE_RELEASE_REQUIRED',
    });

    // Stage a Test pass with a release from the wrong mode, not an eligible legacy row.
    const live = await requireApprovedRelease(kit.ctx, unapproved, kit.org.id, 'live', 'apple');
    const pinned = await kit.registry.resolve(unapproved);
    const pass = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: pinned,
      mode: 'test',
    });
    await setPass(kit, pass.id, 'release_id = ?', [live.id]);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate).toMatchObject({
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
      activeTemplateVersion: null,
    });
    if (!candidate) throw new Error('Missing invalid-release candidate');
    expect(await foundOf(kit.ctx, candidate)).toBeNull();
    const scanner = await kit.scanner({ mode: 'test', settings: { acceptAllTemplates: true } });
    expect(await search(pass.id, scanner.headers)).toEqual({ items: [], more: false });
    const response = await kit.post(scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(await response.json()).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
      display: null,
    });
  });
});

describe('exact lookup IDs', () => {
  it('finds hidden member IDs alongside an independent QR payload without writing a scan', async () => {
    const pass = await kit.scanPass(templateId, { memberNo: '00001234' });
    for (const q of [
      '00001234',
      '0000-1234',
      'opaque:qr:payload',
      pass.id,
      pass.serial,
      pass.scanCode!,
    ])
      expect((await search(q)).items.map((p) => p.passId)).toEqual([pass.id]);
    for (const method of ['manual', 'wedge', 'camera'] as const) {
      const response = await kit.post(kit.admin(), '/resolve', {
        idempotencyKey: key(),
        input: { code: '00001234', method },
        clientTs: kit.clock.now(),
        scope: { orgId: kit.org.id, timeZone: 'UTC' },
      });
      expect(await response.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    }
    const rows = await kit.env.DB.prepare('SELECT count(*) AS n FROM scans').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const json = JSON.stringify(await search('00001234'));
    expect(json).not.toContain('00001234');
    expect(json).not.toContain('opaque:qr:payload');
  });

  it('matches short and email-like external IDs exactly without enabling short name or partial email search', async () => {
    const pass = await kit.scanPass(templateId, { memberName: 'Annabelle', memberNo: '07' });
    expect((await search('07')).items.map((p) => p.passId)).toEqual([pass.id]);
    expect((await search('An')).items).toEqual([]);
    await setPass(kit, pass.id, 'external_id = ?', ['legacy@id']);
    expect((await search('legacy@id')).items.map((p) => p.passId)).toEqual([pass.id]);
    expect((await search('legacy@i')).items).toEqual([]);
    await setPass(kit, pass.id, 'external_id = ?', ['Legacy@example.test']);
    expect((await search('Legacy@example.test')).items.map((p) => p.passId)).toEqual([pass.id]);
  });

  it('scopes exact IDs by organization, mode and accepted templates', async () => {
    const pass = await kit.scanPass(templateId, { memberNo: 'COMMON' });
    await kit.scanPass(templateId, { memberNo: 'COMMON' }, { mode: 'test' });
    const org = await makeOrg(kit.fx, { name: 'Other' });
    const otherTemplate = await kit.scanTemplate(
      'Other org',
      {
        actions: [{ id: 'enter', label: 'Enter', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      },
      { orgId: org.id },
    );
    await kit.scanPass(otherTemplate, { memberNo: 'COMMON' }, { orgId: org.id });
    expect((await search('COMMON')).items.map((p) => p.passId)).toEqual([pass.id]);
    const excluded = await kit.scanner({ templateIds: [otherTemplate] });
    expect((await search(pass.id, excluded.headers)).items).toEqual([]);
    const duplicate = await kit.scanPass(templateId, { memberNo: 'COMMON' });
    expect((await search('COMMON')).items.map((p) => p.passId).sort()).toEqual(
      [pass.id, duplicate.id].sort(),
    );
    const response = await kit.post(kit.admin(), '/resolve', {
      idempotencyKey: key(),
      input: { code: 'COMMON', method: 'wedge' },
      clientTs: kit.clock.now(),
      scope: { orgId: kit.org.id, timeZone: 'UTC' },
    });
    expect(await response.json()).toMatchObject({ reason: 'ambiguous' });
  });
});
