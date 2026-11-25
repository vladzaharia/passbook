import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { bump } from '../../platform/counters.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { csvBody } from './files-fixtures.ts';
import { listFiles, uploadRevision } from './files-revisions.ts';
import { createDraft } from './files-service.ts';
import * as store from './files-store.ts';
import { previewSync, previewUnsaved } from './preview.ts';
import { getConnection } from './repo.ts';
import { prepare } from './runtime.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as schedule from './schedule.ts';
import * as service from './service.ts';
import { executeSync, type StepLike } from './sync-runner.ts';
import { testConfig } from './test-config.ts';
import { addMembership, createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';

let kit: Kit;
let authority: ConnectionAuthority;
let started: ReturnType<typeof vi.spyOn>;
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  kit = await makeKit();
  // Applying starts a real workflow run; the tests drive their own syncs through executeSync.
  vi.spyOn(actions, 'syncNow').mockResolvedValue({ runId: 'applied-run' } as never);
  started = vi
    .spyOn(schedule, 'startSync')
    .mockResolvedValue({ runId: 'relist-run', workflowInstanceId: 'relist-run' });
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const session = (await createSessionStore(kit.env, kit.clock).resolve(
    fixture.cookieValue,
  )) as SessionAuth;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const HEADER = ['id', 'name'];
const rows = (...ids: string[]) => [HEADER, ...ids.map((id) => [id, `Name ${id}`])];
const SIX = rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6');

async function connect(csv: string[][], over: Record<string, unknown> = {}) {
  const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(csv));
  return service.create(kit.sctx, kit.actor, {
    orgId: kit.org.id,
    connectorType: 'file-upload',
    name: 'Members file',
    config: { idColumn: '/id' },
    mode: 'manual',
    fileId: draft.id,
    mapping: { memberName: { from: '/name' } },
    ...over,
  } as never);
}

let n = 0;
async function sync(connectionId: string, step: StepLike = inlineStep()) {
  const conn = await getConnection(kit.env.DB, connectionId);
  const runId = `file-run-${++n}`;
  const params = {
    connectionId,
    orgId: kit.org.id,
    generation: conn?.generation ?? 1,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'admin' as const,
    runId,
    instanceId: runId,
  };
  await seedConnectionWorkflow(kit.sctx, params);
  await executeSync(kit.sctx, step, params);
  return (await getConnection(kit.env.DB, connectionId))?.cursor ?? null;
}

const upload = (id: string, csv: string[][]) =>
  uploadRevision(kit.sctx, kit.actor, authority, id, csvBody(csv), true);
const appliedRefs = () => kit.seams.applied.map((a) => a.fields.memberName);
const uploadsCounted = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COALESCE(SUM(count), 0) AS n FROM counters WHERE key LIKE 'connection-file-upload:%'",
      [],
    )
  )?.n ?? 0;
const reset = () => {
  kit.seams.applied.length = 0;
  kit.seams.missing.length = 0;
  kit.seams.created.length = 0;
};

describe('file-upload through the sync engine', () => {
  it('creates a pass for every row on the first sync', async () => {
    const dto = await connect(SIX, { autoCreate: true, defaultTemplateId: kit.templateId });
    expect(await sync(dto.id)).toMatch(/^fu1:.+:-:done:0$/);
    expect(kit.seams.created.map((c) => c.externalRef).sort()).toEqual(
      SIX.slice(1).map((r) => r[0]),
    );
  });

  it('flags the passes of removed rows and updates changed ones on a re-upload', async () => {
    const dto = await connect(SIX);
    const passes = new Map<string, string>();
    for (const [id] of SIX.slice(1))
      passes.set(id as string, (await linkedPass(kit, dto.id, id as string)).id);
    await sync(dto.id);
    reset();

    const next = rows('m-1', 'm-2', 'm-3');
    next[2] = ['m-2', 'Grace B'];
    const result = await upload(dto.id, next);
    expect(result).toMatchObject({ unchanged: false, state: 'current' });
    await sync(dto.id);

    expect(kit.seams.missing.map((m) => m.passId).sort()).toEqual(
      ['m-4', 'm-5', 'm-6'].map((r) => passes.get(r)).sort(),
    );
    expect(kit.seams.missing.every((m) => m.mode === 'flag')).toBe(true);
    expect(appliedRefs()).toContain('Grace B');
    const files = await listFiles(kit.sctx, authority, dto.id, { limit: 10 });
    expect(files.items.map((f) => [f.state, f.applied])).toEqual([
      ['current', true],
      ['superseded', false],
    ]);
  });

  it('voids removed rows when the connection says void', async () => {
    const dto = await connect(SIX, { onMissing: 'void' });
    const gone = await linkedPass(kit, dto.id, 'm-6');
    await sync(dto.id);
    reset();
    await upload(dto.id, rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5'));
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([{ passId: gone.id, mode: 'void' }]);
  });

  it('does nothing when synced again after done', async () => {
    const dto = await connect(SIX);
    await linkedPass(kit, dto.id, 'm-1');
    const done = await sync(dto.id);
    reset();
    expect(await sync(dto.id)).toBe(done);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });

  it('re-applies every row after a mapping change, and not after a rename', async () => {
    const dto = await connect(SIX);
    for (const [id] of SIX.slice(1)) await linkedPass(kit, dto.id, id as string);
    await sync(dto.id);
    reset();
    await service.update(kit.sctx, kit.actor, dto.id, { name: 'Renamed' });
    await sync(dto.id);
    expect(kit.seams.applied).toEqual([]);
    await service.update(kit.sctx, kit.actor, dto.id, {
      mapping: { memberName: { from: '/name', transform: { kind: 'upper' } } },
    });
    await sync(dto.id);
    expect(appliedRefs().sort()).toEqual(SIX.slice(1).map((r) => `NAME ${r[0]?.toUpperCase()}`));
  });

  it('does the same for a polling connector', async () => {
    const dto = await createDemo(kit, {
      config: { count: 3 },
      mapping: { memberName: { from: '/memberName' } },
    });
    for (const ref of ['m-001', 'm-002', 'm-003']) await linkedPass(kit, dto.id, ref);
    await sync(dto.id);
    reset();
    await service.update(kit.sctx, kit.actor, dto.id, { name: 'Renamed' });
    await sync(dto.id);
    const afterRename = kit.seams.applied.length;
    await service.update(kit.sctx, kit.actor, dto.id, {
      mapping: { memberName: { from: '/memberName', transform: { kind: 'upper' } } },
    });
    await sync(dto.id);
    expect([afterRename, kit.seams.applied.length - afterRename]).toEqual([0, 3]);
  });

  it('unions the bases when a revision lands before the last one finished', async () => {
    const dto = await connect(SIX);
    for (const [id] of SIX.slice(1)) await linkedPass(kit, dto.id, id as string);
    await sync(dto.id);
    const first = (await listFiles(kit.sctx, authority, dto.id, { limit: 1 })).items[0];
    await upload(dto.id, rows('m-1', 'm-2', 'm-3', 'm-4'));
    const second = (await listFiles(kit.sctx, authority, dto.id, { limit: 1 })).items[0];
    // The second revision's run stopped before its removals: its cursor still has the first as a base.
    await run(kit.env.DB, 'UPDATE connections SET cursor = ? WHERE id = ?', [
      `fu1:${second?.id}:${first?.id}:rows:0`,
      dto.id,
    ]);
    reset();
    await upload(dto.id, rows('m-1', 'm-2'));
    await sync(dto.id);
    expect(kit.seams.missing).toHaveLength(4);
  });

  it('fences the run listing the old file when a revision is applied, and the next run lists the new one', async () => {
    const dto = await connect(SIX, { onMissing: 'void' });
    const kept = await linkedPass(kit, dto.id, 'm-6');
    await sync(dto.id);
    await upload(dto.id, rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5'));
    reset();
    const inner = inlineStep();
    let restored = false;
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (!restored && name === 'page-1-apply-0') {
          restored = true;
          // The admin restores m-6 between the removal fetch and its apply.
          await upload(dto.id, SIX);
        }
        return inner.do(name, fn);
      },
    };
    await sync(dto.id, step);
    expect(restored).toBe(true);
    // Apply closed the run that was listing the old file: it stopped without voiding anything.
    expect(kit.seams.missing).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM connection_runs WHERE connection_id = ? AND error_code = 'RUN_LOST'",
        [dto.id],
      ),
    ).not.toBeNull();
    // The run Apply starts (mocked here) begins after the promote and lists the new file.
    const cursor = await sync(dto.id);
    const current = (await listFiles(kit.sctx, authority, dto.id, { limit: 1 })).items[0];
    expect(current).toMatchObject({ rows: 6, applied: true });
    expect(cursor).toBe(`fu1:${current?.id}:-:done:0`);
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.applied.some((a) => a.passId === kept.id)).toBe(true);
  });

  it('voids a removed row only if the current revision still lacks it', async () => {
    const dto = await connect(SIX, { onMissing: 'void' });
    const gone = await linkedPass(kit, dto.id, 'm-6');
    await sync(dto.id);
    await upload(dto.id, rows('m-1', 'm-2', 'm-3', 'm-4', 'm-5'));
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([{ passId: gone.id, mode: 'void' }]);
  });

  it('starts the run itself after an edit that re-lists, and not after a rename', async () => {
    const dto = await connect(SIX);
    await service.update(kit.sctx, kit.actor, dto.id, { name: 'Renamed' });
    expect(started).not.toHaveBeenCalled();
    await service.update(kit.sctx, kit.actor, dto.id, {
      mapping: { memberName: { from: '/name', transform: { kind: 'upper' } } },
    });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('reads the current revision for a single record', async () => {
    const dto = await connect(SIX);
    await upload(dto.id, rows('m-1', 'm-3'));
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('missing connection');
    const { def, cc } = await prepare(kit.sctx, conn);
    expect(await def.fetchRecord(cc, 'm-3')).toEqual({
      status: 'ok',
      record: { id: 'm-3', name: 'Name m-3' },
    });
    expect(await def.fetchRecord(cc, 'm-4')).toEqual({ status: 'not_found' });
  });
});

describe('dry-run preview', () => {
  const plan = { mapping: { memberName: { from: '/name' } }, autoCreate: true };

  it('previews a draft, and counts the re-parse against the upload allowance', async () => {
    const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(SIX));
    const input = {
      orgId: kit.org.id,
      connectorType: 'file-upload',
      config: { idColumn: '/id' },
      fileId: draft.id,
      defaultTemplateId: kit.templateId,
      ...plan,
    } as never;
    const before = await uploadsCounted();
    const res = await previewUnsaved(kit.sctx, input, authority);
    expect(res).toMatchObject({ ok: true, records: 6 });
    expect(res.counts.create + res.counts.waiting).toBe(6);
    expect(await uploadsCounted()).toBe(before + 1);
  });

  it('previews a saved connection against its current revision', async () => {
    const dto = await connect(SIX, { autoCreate: true, defaultTemplateId: kit.templateId });
    await linkedPass(kit, dto.id, 'm-1');
    const res = await previewSync(kit.sctx, dto.id, authority);
    expect(res).toMatchObject({ ok: true, records: 6 });
    expect(res.counts.create + res.counts.waiting).toBe(5);
    expect(res.counts.update + res.counts.unchanged).toBe(1);
  });
});

describe('upload allowance', () => {
  const HOUR = 3_600_000;
  const spend = (by: number) =>
    bump(
      kit.env.DB,
      `connection-file-upload:${kit.org.id}`,
      Math.floor(kit.clock.now() / HOUR) * HOUR,
      by,
    );

  it('refuses a draft test with RATE_LIMITED before it reads the file', async () => {
    const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(SIX));
    await spend(40);
    const read = vi.spyOn(store, 'readSource');
    const res = await testConfig(
      kit.sctx,
      kit.actor,
      {
        orgId: kit.org.id,
        connectorType: 'file-upload',
        config: { idColumn: '/id' },
        fileId: draft.id,
      } as never,
      authority,
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    expect(read).not.toHaveBeenCalled();
  });

  it('counts the parse when a connection is created from a draft', async () => {
    const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(SIX));
    const before = await uploadsCounted();
    await service.create(kit.sctx, kit.actor, {
      orgId: kit.org.id,
      connectorType: 'file-upload',
      name: 'F',
      config: { idColumn: '/id' },
      mode: 'manual',
      fileId: draft.id,
    } as never);
    expect(await uploadsCounted()).toBe(before + 1);
  });

  it('refuses a create at the connections limit before it parses or writes anything', async () => {
    const draft = await createDraft(kit.sctx, kit.actor, authority, csvBody(SIX));
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'connections', '0', 1)",
      [kit.org.id],
    );
    const read = vi.spyOn(store, 'readSource');
    const before = await uploadsCounted();
    await expect(
      service.create(kit.sctx, kit.actor, {
        orgId: kit.org.id,
        connectorType: 'file-upload',
        name: 'F',
        config: { idColumn: '/id' },
        mode: 'manual',
        fileId: draft.id,
      } as never),
    ).rejects.toMatchObject({ code: 'FEATURE_LIMIT_REACHED' });
    expect(read).not.toHaveBeenCalled();
    expect(await uploadsCounted()).toBe(before);
  });
});
