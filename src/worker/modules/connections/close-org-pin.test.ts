// Closing a stale run is a platform job grant, so it names the actor's org on the connection itself.
import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { finishRun, insertRun } from './repo-runs.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

async function runningRun() {
  const dto = await createDemo(kit, {
    mode: 'hybrid',
    connectorType: 'http-json',
    config: { baseUrl: 'https://api.example.com' },
  } as never);
  const runId = kit.ids.id();
  const run = { id: runId, connectionId: dto.id, trigger: 'webhook', startedAt: kit.clock.now() };
  expect(await insertRun(kit.sctx, run, { orgId: kit.org.id })).toBe(true);
  return { connectionId: dto.id, runId };
}

const close = (r: { connectionId: string; runId: string }, orgId: string) =>
  finishRun(
    kit.sctx,
    {
      id: r.runId,
      connectionId: r.connectionId,
      finishedAt: kit.clock.now(),
      outcome: 'skipped',
      recordsSeen: 0,
      passesChanged: 0,
      errorCode: 'STALE_CONTEXT',
      errorDetail: null,
      httpStatus: null,
    },
    { orgId },
  );

const outcome = (runId: string) =>
  first<{ outcome: string }>(kit.env.DB, 'SELECT outcome FROM connection_runs WHERE id = ?', [
    runId,
  ]);

describe('closing a stale connection run', () => {
  it("is refused when the actor names another org than the connection's", async () => {
    const r = await runningRun();
    const other = await makeOrg(kit);
    expect(await close(r, other.id)).toBe(false);
    expect(await outcome(r.runId)).toEqual({ outcome: 'running' });
  });

  it("closes for the connection's own org", async () => {
    const r = await runningRun();
    expect(await close(r, kit.org.id)).toBe(true);
    expect(await outcome(r.runId)).toEqual({ outcome: 'skipped' });
  });
});
