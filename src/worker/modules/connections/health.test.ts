import { beforeEach, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { closeRun, type RunOutcome } from './health.ts';
import { insertRun } from './repo-runs.ts';
import * as service from './service.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const totals = { seen: 1, changed: 0, created: 0, missing: 0, errors: 0 };

async function startedRun(generation: number) {
  const dto = await createDemo(kit, {
    mode: 'hybrid',
    connectorType: 'http-json',
    config: { baseUrl: 'https://api.example.com' },
  } as never);
  const runId = kit.ids.id();
  const started = await insertRun(
    kit.sctx,
    {
      id: runId,
      connectionId: dto.id,
      trigger: 'webhook',
      startedAt: kit.clock.now(),
      expected: {
        orgId: kit.org.id,
        generation,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      },
    },
    { orgId: kit.org.id },
  );
  expect(started).toBe(true);
  const outcome: RunOutcome = {
    source: 'webhook',
    instanceId: null,
    runId,
    orgId: kit.org.id,
    generation,
    connectionMode: 'hybrid',
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    totals,
    failure: null,
    stale: false,
    startedAt: kit.clock.now(),
  };
  return { id: dto.id, runId, outcome };
}

const runRow = (runId: string) =>
  first<{ outcome: string; error_code: string | null }>(
    kit.env.DB,
    'SELECT outcome, error_code FROM connection_runs WHERE id = ?',
    [runId],
  );

describe('closeRun drift classification', () => {
  it('closes a current run as unchanged and keeps the connection healthy', async () => {
    const { id, runId, outcome } = await startedRun(1);
    expect(await closeRun(kit.sctx, id, outcome, { countsForBreaker: true })).toBe(false);
    expect(await runRow(runId)).toEqual({ outcome: 'unchanged', error_code: null });
  });

  it('classifies a config change during the run as STALE_GENERATION', async () => {
    const { id, runId, outcome } = await startedRun(1);
    await service.update(kit.sctx, kit.actor, id, {
      config: { baseUrl: 'https://other.example.com' },
    });
    expect(await closeRun(kit.sctx, id, outcome, { countsForBreaker: true })).toBe(true);
    expect(await runRow(runId)).toEqual({ outcome: 'skipped', error_code: 'STALE_GENERATION' });
  });

  it('classifies a lost connection context as STALE_CONTEXT, not a generation drift', async () => {
    const { id, runId, outcome } = await startedRun(1);
    // Disabling is a bump column too, so generation also moved: context loss must win.
    await service.update(kit.sctx, kit.actor, id, { enabled: false });
    expect(await closeRun(kit.sctx, id, outcome, { countsForBreaker: true })).toBe(true);
    expect(await runRow(runId)).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
  });

  it("reports the pass layer's counter drift as STALE_GENERATION with the generation unchanged", async () => {
    const { id, runId, outcome } = await startedRun(1);
    const stale = { ...outcome, stale: true, staleCode: 'STALE_GENERATION' as const };
    expect(await closeRun(kit.sctx, id, stale, { countsForBreaker: true })).toBe(true);
    expect(await runRow(runId)).toEqual({ outcome: 'skipped', error_code: 'STALE_GENERATION' });
  });

  it('keeps a pass-layer STALE_CONTEXT even when the generation also moved', async () => {
    const { id, runId, outcome } = await startedRun(1);
    await service.update(kit.sctx, kit.actor, id, {
      config: { baseUrl: 'https://other.example.com' },
    });
    const stale = { ...outcome, stale: true, staleCode: 'STALE_CONTEXT' as const };
    expect(await closeRun(kit.sctx, id, stale, { countsForBreaker: true })).toBe(true);
    expect(await runRow(runId)).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
  });

  it('leaves health, cursor and schedule untouched on a stale run', async () => {
    const { id, outcome } = await startedRun(1);
    const read = () =>
      first(
        kit.env.DB,
        'SELECT health, consecutive_failures, cursor, next_run_at, last_run_at FROM connections WHERE id = ?',
        [id],
      );
    await service.update(kit.sctx, kit.actor, id, {
      config: { baseUrl: 'https://other.example.com' },
    });
    const before = await read();
    await closeRun(kit.sctx, id, outcome, { countsForBreaker: true });
    expect(await read()).toEqual(before);
  });
});
