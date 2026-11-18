import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createPassRow } from './create.ts';
import type { CreateParams } from './create-types.ts';
import {
  HEAD,
  type ImportHarness,
  plan,
  setupImportHarness,
  stepOf,
} from './import-test-fixtures.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const keyStarter = (
  over: Partial<Extract<DeferredStarter, { kind: 'api_key' }>> = {},
): DeferredStarter => ({
  kind: 'api_key',
  keyId: h.keyId,
  keyOrgId: h.kit.org.id,
  mode: 'live',
  orgAccessRevision: h.keyAuthority.orgAccessRevision,
  ...over,
});

function deferred(starter: DeferredStarter, over: Partial<CreateParams> = {}): CreateParams {
  const release = h.kit.liveRelease;
  return {
    orgId: h.kit.org.id,
    templateId: h.kit.template.id,
    templateVersion: release?.version ?? '',
    releaseId: release?.id ?? '',
    releaseGeneration: release?.generation ?? 0,
    input: { memberName: 'Direct' },
    source: 'manual',
    mode: 'live',
    execution: { kind: 'deferred', starter },
    actor: { type: 'api_key', id: h.keyId },
    ...over,
  };
}

const passCount = async (externalIds: string[]) =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      `SELECT count(*) AS n FROM passes WHERE org_id = ? AND external_id IN (${externalIds.map(() => '?').join(',')})`,
      [h.kit.org.id, ...externalIds],
    )
  )?.n;

describe('the deferred create principal', () => {
  const job = () => createJobContext(h.kit.env, 'test');

  it('is refused outside a job context', async () => {
    await expect(createPassRow(h.kit.ctx, deferred(keyStarter()))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is refused for another org, another mode or a revoked or retired key', async () => {
    const other = await makeOrg(h.kit.fx, { name: 'Elsewhere' });
    for (const starter of [
      keyStarter({ keyOrgId: other.id }),
      keyStarter({ mode: 'test' }),
      keyStarter({ keyId: 'no-such-key' }),
      keyStarter({ orgAccessRevision: h.keyAuthority.orgAccessRevision + 5 }),
    ])
      await expect(createPassRow(job(), deferred(starter))).rejects.toMatchObject({ status: 403 });
    await expect(
      createPassRow(job(), deferred(keyStarter(), { source: 'connection' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('creates a pass for a live starter, with the starter as the audit actor', async () => {
    const pass = await createPassRow(job(), deferred(keyStarter()));
    const audit = await first<{ actor_type: string; actor_id: string }>(
      h.kit.env.DB,
      "SELECT actor_type, actor_id FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
      [pass.id],
    );
    expect(audit).toEqual({ actor_type: 'api_key', actor_id: h.keyId });
  });
});

describe('revocation stops the run', () => {
  const rows = (n: number, prefix: string) =>
    [HEAD, ...Array.from({ length: n }, (_, i) => `N${i},${i},,${prefix}${i}`)].join('\n');

  it('a key revoked before the run: no pass is created', async () => {
    const key = await h.newKey();
    const d = await h.draft(rows(3, 'RV'), plan(), key.headers);
    expect((await h.commit(d.id, {}, key.headers)).status).toBe(200);
    await run(h.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      h.kit.clock.now(),
      key.id,
    ]);
    expect(await h.runWorkflow(d.id)).toEqual({ state: 'failed', code: 'IMPORT_STARTER_REVOKED' });
    expect(await passCount(['RV0', 'RV1', 'RV2'])).toBe(0);
    expect(await h.get(d.id, h.admin)).toMatchObject({
      state: 'failed',
      errorCode: 'IMPORT_STARTER_REVOKED',
    });
  });

  it('a membership revoked between chunks: the next chunk does not run', async () => {
    const member = await h.newMember();
    const d = await h.draft(rows(45, 'MB'), plan(), member.headers);
    expect((await h.commit(d.id, {}, member.headers)).status).toBe(200);
    const end = await h.runWorkflow(
      d.id,
      stepOf(async (name) => {
        if (name === 'chunk-0')
          await run(
            h.kit.env.DB,
            'UPDATE org_memberships SET revoked_at = ? WHERE user_id = ? AND org_id = ?',
            [h.kit.clock.now(), member.userId, h.kit.org.id],
          );
      }),
    );
    expect(end).toEqual({ state: 'failed', code: 'IMPORT_STARTER_REVOKED' });
    expect(await passCount(Array.from({ length: 45 }, (_, i) => `MB${i}`))).toBe(20);
    expect((await h.get(d.id)).progress).toMatchObject({ created: 20, done: 20 });
  });

  it('a user disabled and enabled again is not the starter any more', async () => {
    const member = await h.newMember();
    const d = await h.draft(rows(2, 'UR'), plan(), member.headers);
    await h.commit(d.id, {}, member.headers);
    await run(h.kit.env.DB, 'UPDATE users SET access_revision = access_revision + 1 WHERE id = ?', [
      member.userId,
    ]);
    expect((await h.runWorkflow(d.id)).code).toBe('IMPORT_STARTER_REVOKED');
    expect(await passCount(['UR0', 'UR1'])).toBe(0);
  });
});

describe('email budget', () => {
  it('emails the first rows within the day budget and lists the rest as not emailed', async () => {
    const now = h.kit.clock.now();
    await run(
      h.kit.env.DB,
      'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 498) ON CONFLICT (key, window_start) DO UPDATE SET count = 498',
      [`pass-email:live:org:${h.kit.org.id}`, now - (now % 86_400_000)],
    );
    const d = await h.draft(
      [HEAD, 'A,1,a@x.co,B1', 'B,1,b@x.co,B2', 'C,1,c@x.co,B3', 'D,1,,B4'].join('\n'),
    );
    expect(d.emailBudget).toBe(2);
    expect((await h.commit(d.id, { email: true })).status).toBe(200);
    await h.runWorkflow(d.id);
    const rows = await all<{ external_id: string; emailed: number }>(
      h.kit.env.DB,
      'SELECT external_id, emailed FROM pass_import_rows WHERE import_id = ? ORDER BY row_no',
      [d.id],
    );
    expect(rows.map((r) => r.emailed)).toEqual([1, 1, 0, 0]);
    const intents = await all<{ recipient: string }>(
      h.kit.env.DB,
      `SELECT recipient FROM pass_issuance_deliveries WHERE pass_id IN
         (SELECT id FROM passes WHERE org_id = ? AND external_id IN ('B1','B2','B3','B4')) ORDER BY recipient`,
      [h.kit.org.id],
    );
    expect(intents.map((i) => i.recipient)).toEqual(['a@x.co', 'b@x.co']);
    const mail = await first<{ n: number }>(
      h.kit.env.DB,
      `SELECT count(*) AS n FROM outbox WHERE kind = 'email' AND pass_id IN
         (SELECT id FROM passes WHERE org_id = ? AND external_id IN ('B1','B2','B3','B4'))`,
      [h.kit.org.id],
    );
    expect(mail?.n).toBe(2);
    expect((await h.get(d.id)).progress).toMatchObject({ created: 4, notEmailed: 1 });
  });

  it('sends nothing unless asked', async () => {
    const d = await h.draft([HEAD, 'A,1,a@x.co,Q1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    const n = await first<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM pass_issuance_deliveries d JOIN passes p ON p.id = d.pass_id WHERE p.external_id = ?',
      ['Q1'],
    );
    expect(n?.n).toBe(0);
    expect((await h.get(d.id)).progress).toMatchObject({ notEmailed: 1 });
  });
});
