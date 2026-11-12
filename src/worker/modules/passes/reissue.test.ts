import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { startBulkReissue } from './bulk.ts';
import { reissuePage } from './bulk-reissue-page.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'user', id: 'admin-1' } as const;

describe('bulk re-sign', () => {
  it('re-signs passes of one identity in place, without moving their template version', async () => {
    const pass = await kit.pass();
    const params = {
      templateId: kit.template.id,
      version: 'ignored-for-resign',
      orgId: kit.org.id,
      identityId: pass.identityId,
      cause: 'resign' as const,
    };
    const result = await reissuePage(jobCtxOf(kit), params, null);
    expect(result).toMatchObject({ failed: 0 });
    expect(result.changed).toBeGreaterThanOrEqual(1);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.objectKey).not.toBe(pass.objectKey);
    expect(after?.templateVersion).toBe(pass.templateVersion);
  });

  it('skips passes signed by another identity', async () => {
    const pass = await kit.pass();
    const result = await reissuePage(
      jobCtxOf(kit),
      {
        templateId: kit.template.id,
        version: kit.template.version,
        orgId: kit.org.id,
        identityId: 'some-other-identity',
        cause: 'resign',
      },
      null,
    );
    expect(result).toEqual({ nextCursor: null, changed: 0, unchanged: 0, failed: 0 });
    expect((await getPass(kit.env.DB, pass.id))?.objectKey).toBe(pass.objectKey);
  });

  it('passes the cause and identity to the workflow', async () => {
    kit.workflow.created.length = 0;
    await startBulkReissue(kit.ctx, actor, {
      templateId: kit.template.id,
      orgId: kit.org.id,
      cause: 'resign',
      identityId: 'id-1',
    });
    expect(kit.workflow.created[0]?.params).toMatchObject({ cause: 'resign', identityId: 'id-1' });
  });

  it('re-signs an identity across templates and audits it against the identity', async () => {
    const pass = await kit.pass();
    const result = await reissuePage(
      jobCtxOf(kit),
      {
        templateId: null,
        version: null,
        orgId: null,
        identityId: pass.identityId,
        cause: 'resign',
      },
      null,
    );
    expect(result.failed).toBe(0);
    expect(result.changed).toBeGreaterThanOrEqual(1);
    kit.workflow.created.length = 0;
    await startBulkReissue(kit.ctx, actor, { cause: 'resign', identityId: pass.identityId });
    expect(kit.workflow.created[0]?.params).toMatchObject({
      templateId: null,
      identityId: pass.identityId,
    });
    const audit = await first<{ target_type: string; target_id: string }>(
      kit.env.DB,
      "SELECT target_type, target_id FROM audit_log WHERE action = 'pass.bulk_reissue' ORDER BY id DESC LIMIT 1",
    );
    expect(audit).toEqual({ target_type: 'identity', target_id: pass.identityId });
  });

  it('defaults to a template upgrade', async () => {
    kit.workflow.created.length = 0;
    await startBulkReissue(kit.ctx, actor, { templateId: kit.template.id, orgId: kit.org.id });
    expect(kit.workflow.created[0]?.params).toMatchObject({
      cause: 'template_upgrade',
      identityId: null,
    });
  });
});
