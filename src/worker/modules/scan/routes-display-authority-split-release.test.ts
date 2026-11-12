import { beforeEach, describe, expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  approveAppleRelease,
  createAppleReleaseCandidate,
} from '../passes/apple-release-test-fixtures.ts';
import { setArchived } from '../templates/lifecycle.ts';
import { basicPackage } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import {
  createPreviewAuthorityFixture,
  type PreviewAuthorityFixture,
} from './routes-display-authority-split-fixture.ts';

let fixture: PreviewAuthorityFixture;

beforeEach(async () => {
  fixture = await createPreviewAuthorityFixture();
});

describe('scan display preview tenant authorization', () => {
  it('authorizes a real global baked template by the pass org, not the template org', async () => {
    const {
      env,
      clock,
      f,
      org,
      otherOrg,
      memberSession,
      seedWalletSnapshot,
      preview,
      problem,
      previewAudits,
    } = fixture;
    const session = await memberSession(['pass_operator']);
    const baked = await bakedFrom(`preview-${f.ids.token(6)}`, basicPackage());
    const source = sourceOf([baked], generatedSource.hash);
    const original = { ...generatedSource };
    const originalAssets = env.ASSETS;
    Object.assign(generatedSource, source);
    Object.assign(env, { ASSETS: fakeAssets(baked.files) });
    resetBakedSync();
    try {
      const ctx = createServiceContext(env, { clock });
      await syncBakedTemplates(ctx);
      const platformTemplate = await createTemplateRegistry(env, { ctx }).resolve(
        baked.template.id,
        baked.template.version,
      );
      const localPass = await makePass(f, { orgId: org.id, template: platformTemplate });
      const otherPass = await makePass(f, { orgId: otherOrg.id, template: platformTemplate });
      await seedWalletSnapshot(localPass, platformTemplate);
      await seedWalletSnapshot(otherPass, platformTemplate);
      const local = { orgId: org.id, templateId: platformTemplate.id, passId: localPass.id };
      const other = { orgId: otherOrg.id, templateId: platformTemplate.id, passId: otherPass.id };
      expect((await preview(local, session.headers)).status).toBe(200);
      const unknown = await preview({ ...local, passId: f.ids.id() }, session.headers);
      const forged = await preview({ ...other, orgId: org.id }, session.headers);
      const unowned = await preview(other, session.headers);
      expect(unknown.status).toBe(404);
      expect(forged.status).toBe(404);
      expect(unowned.status).toBe(404);
      const expected = await problem(unknown);
      expect(await problem(forged)).toEqual(expected);
      expect(await problem(unowned)).toEqual(expected);
      expect(await previewAudits(session.userId)).toEqual([
        { org_id: org.id, target_id: localPass.id },
      ]);
    } finally {
      Object.assign(generatedSource, original);
      Object.assign(env, { ASSETS: originalAssets });
      resetBakedSync();
    }
  });

  it('uses the approved scoped release even without a legacy active version', async () => {
    const { env, org, own, memberSession, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    await run(env.DB, 'UPDATE templates SET active_version = NULL WHERE id = ?', [own.templateId]);
    const response = await preview(own, session.headers);
    expect(response.status).toBe(200);
    expect(await previewAudits(session.userId)).toEqual([
      { org_id: org.id, target_id: own.passId },
    ]);
  });

  it('uses the pinned legacy version only while scoped release history is absent', async () => {
    const {
      env,
      org,
      otherOrg,
      foreignTest,
      foreignReleaseFixture,
      memberSession,
      releaseState,
      preview,
      previewAudits,
    } = fixture;
    const session = await memberSession(['pass_operator'], otherOrg.id);
    await run(env.DB, 'UPDATE templates SET active_version = NULL WHERE id = ?', [
      foreignTest.templateId,
    ]);
    const headers = { ...session.headers, 'x-passbook-mode': 'test' };
    const options = {
      orgId: otherOrg.id,
      templateId: foreignTest.templateId,
      version: 'v1',
      mode: 'test' as const,
    };
    expect(await releaseState(foreignTest.passId)).toEqual({ absent: 1, head: null });
    expect((await preview(foreignTest, headers, { mode: 'test', role: 'manager' })).status).toBe(
      403,
    );
    expect(
      (await preview({ ...foreignTest, orgId: org.id }, headers, { mode: 'test' })).status,
    ).toBe(404);
    expect((await preview(foreignTest, headers, { mode: 'test' })).status).toBe(200);
    await createAppleReleaseCandidate(foreignReleaseFixture, options);
    expect(await releaseState(foreignTest.passId)).toEqual({ absent: 1, head: null });
    expect((await preview(foreignTest, headers, { mode: 'test' })).status).toBe(200);
    const release = await approveAppleRelease(foreignReleaseFixture, options);
    expect(await releaseState(foreignTest.passId)).toEqual({ absent: 0, head: release.id });
    expect((await preview(foreignTest, headers, { mode: 'test' })).status).toBe(200);
    expect(await previewAudits(session.userId)).toEqual([
      { org_id: otherOrg.id, target_id: foreignTest.passId },
      { org_id: otherOrg.id, target_id: foreignTest.passId },
      { org_id: otherOrg.id, target_id: foreignTest.passId },
    ]);
  });

  it('never treats an issued pass with a wrong-mode release as legacy', async () => {
    const {
      env,
      otherOrg,
      foreign,
      foreignTest,
      memberSession,
      releaseState,
      preview,
      previewAudits,
    } = fixture;
    const session = await memberSession(['pass_operator'], otherOrg.id);
    const liveHead = await releaseState(foreign.passId);
    if (!liveHead?.head) throw new Error('Missing Live release');
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      liveHead.head,
      foreignTest.passId,
    ]);
    expect(await releaseState(foreignTest.passId)).toEqual({ absent: 1, head: null });
    const response = await preview(
      foreignTest,
      { ...session.headers, 'x-passbook-mode': 'test' },
      { mode: 'test' },
    );
    expect(response.status).toBe(404);
    expect(await previewAudits(session.userId)).toEqual([]);
  });

  it('masks an issued pass pinned to another tenant release', async () => {
    const { env, f, own, foreign, memberSession, releaseState, preview, problem, previewAudits } =
      fixture;
    const session = await memberSession(['pass_operator']);
    const foreignHead = await releaseState(foreign.passId);
    if (!foreignHead?.head) throw new Error('Missing foreign release');
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      foreignHead.head,
      own.passId,
    ]);
    const response = await preview(own, session.headers);
    const unknown = await preview({ ...own, passId: f.ids.id() }, session.headers);
    expect(response.status).toBe(404);
    expect(await problem(response)).toEqual(await problem(unknown));
    expect(await previewAudits(session.userId)).toEqual([]);
  });

  it('serves the pass own release when the template is archived', async () => {
    const { env, clock, org, own, memberSession, releaseState, preview, previewAudits } = fixture;
    const reader = await memberSession(['pass_operator']);
    const admin = await memberSession(['org_admin']);
    const auth = await createSessionStore(env, clock).resolve(admin.cookieValue);
    if (!auth) throw new Error('Missing template administrator session');
    expect((await preview(own, reader.headers)).status).toBe(200);
    expect(await releaseState(own.passId)).toMatchObject({ absent: 0, head: expect.any(String) });
    await setArchived(createServiceContext(env, { clock }), auth, own.templateId, true);
    expect(await releaseState(own.passId)).toEqual({ absent: 0, head: null });
    // An archived template has no head; the pass's own issued release still serves the preview.
    expect((await preview(own, reader.headers)).status).toBe(200);
    expect(await previewAudits(reader.userId)).toEqual([
      { org_id: org.id, target_id: own.passId },
      { org_id: org.id, target_id: own.passId },
    ]);
  });

  it('does not disclose a legacy scope if an approved head appears before return', async () => {
    const {
      otherOrg,
      foreignTest,
      foreignReleaseFixture,
      memberSession,
      releaseState,
      atPreviewAudit,
      preview,
    } = fixture;
    const session = await memberSession(['pass_operator'], otherOrg.id);
    expect(await releaseState(foreignTest.passId)).toEqual({ absent: 1, head: null });
    const response = await atPreviewAudit(
      async (db) => {
        await approveAppleRelease(foreignReleaseFixture, {
          orgId: otherOrg.id,
          templateId: foreignTest.templateId,
          version: 'v1',
          mode: 'test',
          db,
        });
      },
      () =>
        preview(foreignTest, { ...session.headers, 'x-passbook-mode': 'test' }, { mode: 'test' }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('scope');
  });

  it('keeps Live and Test preview scoped to the selected request mode', async () => {
    const { org, ownTest, memberSession, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    expect((await preview(ownTest, session.headers)).status).toBe(404);
    expect((await preview(ownTest, session.headers, { mode: 'test' })).status).toBe(404);
    const response = await preview(
      ownTest,
      { ...session.headers, 'x-passbook-mode': 'test' },
      { mode: 'test' },
    );
    expect(response.status).toBe(200);
    expect(await previewAudits(session.userId)).toEqual([
      { org_id: org.id, target_id: ownTest.passId },
    ]);
  });
});
