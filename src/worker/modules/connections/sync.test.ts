import { beforeEach, describe, expect, it } from 'vitest';
import { guardWrites } from '../../../../test/helpers/guarded-step.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { setDeps } from './deps.ts';
import { breakerDelayMs } from './health.ts';
import { getConnection } from './repo.ts';
import { listRuns } from './repo-runs.ts';
import { reconcileConnections } from './schedule.ts';
import * as service from './service.ts';
import { executeSync, type StepLike, type SyncRunParams } from './sync-runner.ts';
import { createDemo, inlineStep, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let n = 0;
beforeEach(async () => {
  kit = await makeKit();
});

async function sync(
  connectionId: string,
  over: Partial<SyncRunParams> = {},
  step: StepLike = inlineStep(),
) {
  const runId = `run-${kit.org.id.slice(-6)}-${++n}`;
  const conn = await getConnection(kit.env.DB, connectionId);
  await executeSync(kit.sctx, step, {
    connectionId,
    orgId: conn?.orgId ?? kit.org.id,
    generation: conn?.generation ?? 1,
    trigger: 'schedule',
    runId,
    instanceId: runId,
    ...over,
  });
  const conn2 = await getConnection(kit.env.DB, connectionId);
  const runRow = await first<{
    outcome: string;
    error_code: string | null;
    records_seen: number;
    passes_changed: number;
    http_status: number | null;
    duration_ms: number | null;
  }>(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [over.runId ?? runId]);
  return { conn: conn2, run: runRow, runId };
}

const passRow = (id: string) =>
  first<{
    sync_error_code: string | null;
    last_synced_at: number | null;
    next_sync_at: number | null;
    sync_failures: number;
  }>(
    kit.env.DB,
    'SELECT sync_error_code, last_synced_at, next_sync_at, sync_failures FROM passes WHERE id = ?',
    [id],
  );

describe('sync happy path (listChanges)', () => {
  it('applies changes to linked passes and records a healthy run', async () => {
    const dto = await createDemo(kit, { config: { count: 3 } });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    const p2 = await linkedPass(kit, dto.id, 'm-002');
    kit.clock.advance(1000);

    const { conn, run: r } = await sync(dto.id);

    expect(kit.seams.applied.map((a) => a.passId).sort()).toEqual([p1.id, p2.id].sort());
    expect(kit.seams.applied[0]).toMatchObject({
      connectionId: dto.id,
      generation: 1,
      cause: 'connection',
      fields: { memberName: 'Member M-001', memberId: 'm-001' },
    });
    expect(r).toMatchObject({
      outcome: 'changed',
      records_seen: 3,
      passes_changed: 2,
      error_code: null,
    });
    expect(conn).toMatchObject({
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: kit.clock.now(),
      cursor: '0:3',
      nextRunAt: kit.clock.now() + 60_000,
    });
    expect((await passRow(p1.id))?.last_synced_at).toBe(kit.clock.now());
    expect(kit.seams.created).toEqual([]);
  });

  it('reports unchanged when the passes service says nothing changed', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'unchanged', passes_changed: 0, records_seen: 2 });
  });

  it('pages through the whole listing and resumes from the stored cursor', async () => {
    const dto = await createDemo(kit, { config: { count: 25 } });
    const step = inlineStep();
    const { run: r, conn } = await sync(dto.id, {}, step);
    expect(step.names.filter((s) => /^page-\d+$/.test(s))).toEqual(['page-0', 'page-1', 'page-2']);
    expect(r?.records_seen).toBe(25);
    expect(conn?.cursor).toBe('0:25');
    const again = await sync(dto.id);
    expect(again.run?.records_seen).toBe(0);
    expect(again.run?.outcome).toBe('unchanged');
  });

  it('restarts the listing when upstream changes revision', async () => {
    const dto = await createDemo(kit, { config: { count: 4 } });
    await linkedPass(kit, dto.id, 'm-001');
    await sync(dto.id);
    kit.seams.applied.length = 0;
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 4, revision: 1 } });
    await sync(dto.id);
    expect(kit.seams.applied).toHaveLength(1);
  });
});

describe('mapping and validation', () => {
  it('maps upstream fields with transforms before applying', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      mapping: {
        memberName: { from: '/memberName', transform: { kind: 'upper' } },
        level: { from: '/tier', transform: { kind: 'enum', options: { map: {}, default: 'x' } } },
        org: { from: '', transform: { kind: 'constant', options: { value: 'Henry' } } },
      },
    });
    await linkedPass(kit, dto.id, 'm-001');
    await sync(dto.id);
    expect(kit.seams.applied[0]?.fields).toEqual({
      memberName: 'MEMBER M-001',
      level: 'x',
      org: 'Henry',
    });
  });

  it('flags an invalid record on its pass, keeps going and marks the run degraded', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      mapping: {
        memberName: { from: '', transform: { kind: 'constant', options: { value: '' } } },
      },
    });
    const p = await linkedPass(kit, dto.id, 'm-001');
    const { conn, run: r } = await sync(dto.id);
    expect(kit.seams.applied).toEqual([]);
    expect(r).toMatchObject({ outcome: 'unchanged', error_code: 'RECORD_ERRORS', records_seen: 2 });
    expect(conn).toMatchObject({
      health: 'degraded',
      consecutiveFailures: 0,
      lastErrorCode: 'RECORD_ERRORS',
    });
    expect((await passRow(p.id))?.sync_error_code).toBe('INVALID_INPUT');
    expect((await passRow(p.id))?.sync_failures).toBe(1);
  });

  it('isolates a failing pass update from the rest', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    await linkedPass(kit, dto.id, 'm-002');
    setDeps({
      applyConnectionRecord: async (_c, input) => {
        if (input.passId === p1.id) throw new NotFoundError('gone', 'PASS_BUSY');
        return {
          changed: true,
          version: input.expectedVersion,
          ownerUserId: input.ownerUserId,
          linkGeneration: input.linkGeneration,
        };
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ records_seen: 2, passes_changed: 1, error_code: 'RECORD_ERRORS' });
    expect((await passRow(p1.id))?.sync_error_code).toBe('PASS_BUSY');
  });

  it('records the first failing records in the run detail', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      mapping: {
        memberName: { from: '', transform: { kind: 'constant', options: { value: '' } } },
      },
    });
    await linkedPass(kit, dto.id, 'm-001');
    await linkedPass(kit, dto.id, 'm-002');
    const { runId } = await sync(dto.id);
    const row = await first<{ error_detail: string | null }>(
      kit.env.DB,
      'SELECT error_detail FROM connection_runs WHERE id = ?',
      [runId],
    );
    expect(row?.error_detail).toContain('m-001: INVALID_INPUT');
    expect(row?.error_detail?.split('\n')).toHaveLength(2);
  });

  it('never flags a pass for a lost publish race', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new ConflictError('race', 'PASS_CONFLICT');
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
    const row = await passRow(p.id);
    expect(row).toMatchObject({ sync_error_code: null, sync_failures: 0, next_sync_at: null });
  });

  it('does not flag a pass for internal errors', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new Error('D1 down');
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'INTERNAL' });
    expect(await passRow(p.id)).toMatchObject({ sync_error_code: null, sync_failures: 0 });
  });
});

describe('auto_create', () => {
  it('does not create passes when off', async () => {
    const dto = await createDemo(kit, { config: { count: 3 } });
    const { run: r } = await sync(dto.id);
    expect(kit.seams.created).toEqual([]);
    expect(r).toMatchObject({ outcome: 'unchanged', records_seen: 3 });
  });

  it('creates passes for new refs when on, without emailing by default', async () => {
    const dto = await createDemo(kit, {
      config: { count: 3 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      holderEmailField: '/email',
    });
    await linkedPass(kit, dto.id, 'm-001');
    const { run: r } = await sync(dto.id);
    expect(kit.seams.created.map((c) => c.externalRef).sort()).toEqual(['m-002', 'm-003']);
    expect(kit.seams.created[0]).toMatchObject({
      orgId: kit.org.id,
      templateId: kit.templateId,
      connectionId: dto.id,
      sendEmail: false,
      holderEmail: expect.stringMatching(/^m-00[23]@example\.com$/),
    });
    expect(r).toMatchObject({ outcome: 'changed', passes_changed: 3 });
  });

  it('emails new passes only when auto_email is on and there is an address', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
      holderEmailField: '/email',
    });
    await sync(dto.id);
    expect(kit.seams.created.every((c) => c.sendEmail)).toBe(true);

    kit.seams.created.length = 0;
    const noEmail = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
    });
    await sync(noEmail.id);
    expect(kit.seams.created[0]).toMatchObject({ holderEmail: null, sendEmail: false });
  });

  it('skips records that fail template validation', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/nope' } },
    });
    const { run: r } = await sync(dto.id);
    expect(kit.seams.created).toEqual([]);
    expect(r?.error_code).toBe('RECORD_ERRORS');
  });
});

describe('on_missing', () => {
  async function missingRun(onMissing: 'keep' | 'flag' | 'void') {
    const dto = await createDemo(kit, { config: { count: 3, missing: ['m-002'] }, onMissing });
    const p = await linkedPass(kit, dto.id, 'm-002');
    const out = await sync(dto.id);
    return { p, ...out };
  }

  it('flags', async () => {
    const { p, run: r } = await missingRun('flag');
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'flag' }]);
    expect(r?.passes_changed).toBe(1);
  });

  it('voids', async () => {
    const { p } = await missingRun('void');
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'void' }]);
  });

  it('keeps: leaves the pass alone', async () => {
    const { p, run: r } = await missingRun('keep');
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(r?.passes_changed).toBe(0);
    expect((await passRow(p.id))?.last_synced_at).not.toBeNull();
  });

  it('ignores deletions for refs that have no pass', async () => {
    const dto = await createDemo(kit, { config: { count: 3, missing: ['m-002'] } });
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([]);
  });
});

describe('failures never touch passes', () => {
  it.each([
    ['auth', 'AUTH'],
    ['timeout', 'TIMEOUT'],
    ['upstream', 'UPSTREAM'],
    ['rate_limited', 'RATE_LIMITED'],
  ])('%s', async (fail, code) => {
    const dto = await createDemo(kit, { config: { count: 3, fail }, onMissing: 'void' });
    const p = await linkedPass(kit, dto.id, 'm-001');
    const { conn, run: r } = await sync(dto.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    const row = await passRow(p.id);
    expect(row).toMatchObject({ sync_error_code: null, last_synced_at: null, sync_failures: 0 });
    expect(r).toMatchObject({ outcome: 'error', error_code: code });
    expect(conn).toMatchObject({ health: 'degraded', consecutiveFailures: 1, lastErrorCode: code });
  });

  it('records the HTTP status of the failure', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'auth' } });
    expect((await sync(dto.id)).run?.http_status).toBe(401);
  });

  it('a later success resets the failure count', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'timeout' } });
    await sync(dto.id);
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
    const { conn } = await sync(dto.id);
    expect(conn).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
  });
});

describe('circuit breaker', () => {
  it('doubles from 5 minutes to a 1 hour cap', () => {
    expect([1, 4].map(breakerDelayMs)).toEqual([300_000, 300_000]);
    expect([5, 6, 7, 8, 9, 20].map(breakerDelayMs)).toEqual([
      300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000,
    ]);
  });

  it('opens after 5 consecutive failures, audits once, and blocks scheduling until it elapses', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'upstream' } });
    const { sctx, created } = withWorkflow(kit);
    const mine = () => created.filter((c) => c.params.connectionId === dto.id);
    for (let i = 0; i < 4; i++) {
      const { conn } = await sync(dto.id);
      expect(conn?.breakerOpenUntil).toBeNull();
      kit.clock.advance(61_000);
    }
    const fifth = await sync(dto.id);
    expect(fifth.conn).toMatchObject({
      health: 'failing',
      consecutiveFailures: 5,
      breakerOpenUntil: kit.clock.now() + 300_000,
    });
    expect(fifth.conn?.nextRunAt).toBe(kit.clock.now() + 300_000);
    const audits = await all(
      kit.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'connection.breaker_open' AND target_id = ?",
      [dto.id],
    );
    expect(audits).toHaveLength(1);

    kit.clock.advance(120_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect(mine()).toEqual([]);

    // Half-open: the next run after the window is a probe. A failure re-opens for longer.
    kit.clock.advance(300_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect(mine()).toHaveLength(1);
    const sixth = await sync(dto.id);
    expect(sixth.conn?.breakerOpenUntil).toBe(kit.clock.now() + 600_000);
    expect(
      await all(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'connection.breaker_open' AND target_id = ?",
        [dto.id],
      ),
    ).toHaveLength(1);

    // A successful probe closes it.
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
    kit.clock.advance(1);
    const ok = await sync(dto.id);
    expect(ok.conn).toMatchObject({
      health: 'healthy',
      consecutiveFailures: 0,
      breakerOpenUntil: null,
    });
  });
});

describe('generation fence', () => {
  it('skips a run started for an old generation', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    await linkedPass(kit, dto.id, 'm-001');
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 2, seed: 'new' } });
    const { run: r, conn } = await sync(dto.id, { generation: 1 });
    expect(r).toBeNull();
    expect(kit.seams.applied).toEqual([]);
    expect(conn).toMatchObject({ health: 'unknown', consecutiveFailures: 0, lastRunAt: null });
  });

  it('stops mid-run when the connection changes, without moving the cursor or health', async () => {
    const dto = await createDemo(kit, { config: { count: 25 } });
    await linkedPass(kit, dto.id, 'm-001');
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (name === 'page-1') {
          await service.update(kit.sctx, kit.actor, dto.id, {
            mapping: { memberName: { from: '/memberName' } },
          });
        }
        return inner.do(name, fn);
      },
    };
    const { run: r, conn } = await sync(dto.id, { generation: 1 }, step);
    expect(r?.outcome).toBe('skipped');
    expect(conn?.generation).toBe(2);
    expect(conn?.cursor).toBe('0:10');
    expect(conn?.health).toBe('unknown');
    expect(kit.seams.applied).toHaveLength(1);
  });

  it('does not let a failing stale run open the breaker', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'auth' } });
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (name === 'finish') {
          await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
        }
        return inner.do(name, fn);
      },
    };
    const { conn } = await sync(dto.id, {}, step);
    expect(conn).toMatchObject({ consecutiveFailures: 0, generation: 2 });
  });

  it('ignores disabled and deleted connections', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    expect((await sync(dto.id, { generation: 1 })).run).toBeNull();
    await service.remove(kit.sctx, kit.actor, dto.id);
    const step = inlineStep();
    await sync(dto.id, {}, step);
    expect(step.names).toEqual(['start', 'mark-gone']);
  });
});

describe('fan-out over passes (no listChanges)', () => {
  const upstream: { calls: string[]; status: number; body: object } = {
    calls: [],
    status: 200,
    body: {},
  };

  async function httpConn(over: Record<string, unknown> = {}) {
    upstream.calls = [];
    upstream.status = 200;
    upstream.body = { memberName: 'From API' };
    setDeps({
      fetchImpl: (async (url: string) => {
        upstream.calls.push(String(url));
        return new Response(JSON.stringify(upstream.body), {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com/v1', recordPath: '/members/{ref}' },
      secrets: { token: 'abc' },
      maxConcurrency: 2,
      requestsPerMinute: 60,
      ...over,
    } as never);
  }

  it('fetches due passes in chunks of maxConcurrency, pacing between chunks', async () => {
    const dto = await httpConn();
    for (const ref of ['r1', 'r2', 'r3', 'r4', 'r5']) await linkedPass(kit, dto.id, ref);
    const step = inlineStep();
    const { run: r } = await sync(dto.id, {}, step);
    expect(step.names).toEqual([
      'start',
      'limits',
      'due',
      'chunk-0',
      'chunk-2',
      'chunk-4',
      'finish',
    ]);
    expect(step.sleeps).toEqual([2000, 2000]);
    expect(upstream.calls.sort()).toEqual(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((x) => `https://api.example.com/v1/members/${x}`),
    );
    expect(kit.seams.applied).toHaveLength(5);
    expect(r).toMatchObject({ outcome: 'changed', records_seen: 5 });
  });

  it('only fetches passes whose next_sync_at has come', async () => {
    const dto = await httpConn();
    const due = await linkedPass(kit, dto.id, 'due');
    const later = await linkedPass(kit, dto.id, 'later');
    await run(kit.env.DB, 'UPDATE passes SET next_sync_at = ? WHERE id = ?', [
      kit.clock.now() + 60_000,
      later.id,
    ]);
    await sync(dto.id);
    expect(kit.seams.applied.map((a) => a.passId)).toEqual([due.id]);
    expect((await passRow(due.id))?.next_sync_at).toBe(kit.clock.now() + 900_000);
  });

  it('stops at the first upstream failure and leaves passes alone', async () => {
    const dto = await httpConn();
    for (const ref of ['r1', 'r2', 'r3']) await linkedPass(kit, dto.id, ref);
    upstream.status = 401;
    const step = inlineStep();
    const { run: r, conn } = await sync(dto.id, {}, step);
    expect(step.names.filter((s) => s.startsWith('chunk'))).toEqual(['chunk-0']);
    expect(kit.seams.applied).toEqual([]);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'AUTH', http_status: 401 });
    expect(conn?.consecutiveFailures).toBe(1);
  });

  it('applies on_missing to a 404 and leaves the others', async () => {
    const dto = await httpConn({ onMissing: 'void' });
    const p = await linkedPass(kit, dto.id, 'gone');
    upstream.status = 404;
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'void' }]);
  });

  it('never fetches private or unsafe hosts, even if the stored config was tampered with', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    await run(kit.env.DB, 'UPDATE connections SET config = ? WHERE id = ?', [
      JSON.stringify({ baseUrl: 'https://127.0.0.1/v1', recordPath: '/{ref}' }),
      dto.id,
    ]);
    const { run: r } = await sync(dto.id);
    expect(upstream.calls).toEqual([]);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'CONFIG' });
    expect(kit.seams.applied).toEqual([]);
  });

  it('does not fetch when DNS resolves to a private address', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    setDeps({ resolver: { resolve: async () => ['10.1.2.3'] } });
    const { run: r } = await sync(dto.id);
    expect(upstream.calls).toEqual([]);
    expect(r?.error_code).toBe('CONFIG');
  });

  it('counts a malformed payload as a record error, not a connection failure', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    upstream.body = [1, 2, 3];
    const { run: r, conn } = await sync(dto.id);
    expect(r).toMatchObject({ error_code: 'RECORD_ERRORS' });
    expect(conn).toMatchObject({ consecutiveFailures: 0, health: 'degraded' });
  });

  it('fails the run with CONFIG when the stored secret no longer matches the schema', async () => {
    const dto = await httpConn({
      secrets: undefined,
      config: { baseUrl: 'https://api.example.com', auth: { type: 'bearer' } },
    });
    await linkedPass(kit, dto.id, 'r1');
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'CONFIG' });
    expect(upstream.calls).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('never touches passes of another org that share a ref', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const mine = await linkedPass(kit, dto.id, 'm-001');
    const { makeOrg } = await import('../../../../test/helpers/index.ts');
    const other = await makeOrg(kit);
    const theirs = await linkedPass(kit, dto.id, 'm-001', other.id);
    await sync(dto.id);
    expect(kit.seams.applied.map((a) => a.passId)).toEqual([mine.id]);
    expect((await passRow(theirs.id))?.last_synced_at).toBeNull();
  });
});

describe('run history', () => {
  it('lists runs newest first', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    await sync(dto.id);
    kit.clock.advance(1000);
    await sync(dto.id);
    const runs = await listRuns(kit.env.DB, dto.id, { limit: 10 });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.startedAt).toBeGreaterThan(runs[1]?.startedAt ?? 0);
    expect(runs[0]?.durationMs).toBe(0);
  });
});

describe('workflow writes stay inside steps', () => {
  const params = (connectionId: string, generation: number): SyncRunParams => ({
    connectionId,
    orgId: kit.org.id,
    generation,
    trigger: 'schedule',
    runId: `run-guard-${connectionId.slice(-6)}`,
    instanceId: `inst-guard-${connectionId.slice(-6)}`,
  });
  const seedWorkflowRun = (instanceId: string) =>
    run(
      kit.env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, status, org_id, started_at) VALUES (?, 'connection_sync', 'running', ?, 1)",
      [instanceId, kit.org.id],
    );

  it('records a gone connection in the mark-gone step', async () => {
    const dto = await createDemo(kit);
    await service.remove(kit.sctx, kit.actor, dto.id);
    const guard = guardWrites(kit.env);
    const step = guard.step(inlineStep());
    const p = params(dto.id, 1);
    await seedWorkflowRun(p.instanceId);
    await executeSync({ ...kit.sctx, env: guard.env }, step, p);
    expect(guard.violations).toEqual([]);
    expect(
      (
        await first<{ status: string }>(
          kit.env.DB,
          'SELECT status FROM workflow_runs WHERE instance_id = ?',
          [p.instanceId],
        )
      )?.status,
    ).toBe('complete');
  });

  it('records an aborted run in the abort-record step', async () => {
    const dto = await createDemo(kit);
    const guard = guardWrites(kit.env);
    const inner = inlineStep();
    const flaky: StepLike = {
      ...inner,
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (name === 'limits') throw new Error('boom');
        return inner.do(name, fn);
      },
    };
    const step = guard.step(flaky);
    const p = params(dto.id, (await getConnection(kit.env.DB, dto.id))?.generation ?? 1);
    await seedWorkflowRun(p.instanceId);
    await expect(executeSync({ ...kit.sctx, env: guard.env }, step, p)).rejects.toThrow('boom');
    expect(guard.violations).toEqual([]);
    expect(
      (
        await first<{ status: string }>(
          kit.env.DB,
          'SELECT status FROM workflow_runs WHERE instance_id = ?',
          [p.instanceId],
        )
      )?.status,
    ).toBe('errored');
  });
});
