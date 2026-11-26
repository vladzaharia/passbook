import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { resetDeps, setDeps } from './deps.ts';
import { getConnection } from './repo.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { executeSync, type SyncRunParams } from './sync-runner.ts';
import { type Kit, makeKit, publicResolver } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => resetDeps());

async function rest(maxPages: number) {
  setDeps({
    resolver: publicResolver,
    fetchImpl: async (input) => {
      const at = Number(new URL(String(input)).searchParams.get('offset'));
      return new Response(JSON.stringify({ items: [{ id: `r${at}` }, { id: `r${at + 1}` }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return service.create(kit.sctx, kit.actor, {
    orgId: kit.org.id,
    connectorType: 'http-json',
    name: 'REST',
    mode: 'poll',
    config: {
      baseUrl: 'https://api.example.com/v1',
      list: { path: '/m', maxPages, pagination: { style: 'offset', size: 2 } },
    },
  } as never);
}

async function sync(connectionId: string, runId: string) {
  const conn = await getConnection(kit.env.DB, connectionId);
  const params: SyncRunParams = {
    connectionId,
    orgId: kit.org.id,
    generation: conn?.generation ?? 1,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule',
    runId,
    instanceId: runId,
    writeBudget: 15,
  };
  await seedConnectionWorkflow(kit.sctx, params);
  await executeSync(kit.sctx, inlineStep(), params);
  return first<{ outcome: string; error_detail: string | null }>(
    kit.env.DB,
    'SELECT outcome, error_detail FROM connection_runs WHERE id = ?',
    [runId],
  );
}

describe('a run that stops at maxPages', () => {
  it('says so on the run, not only in the log', async () => {
    const dto = await rest(2);
    const row = await sync(dto.id, `run-${kit.org.id.slice(-6)}-1`);
    expect(row?.error_detail).toMatch(/^MAX_PAGES: stopped at 2 pages; the next run continues/);
  });

  it('adds nothing when the listing ends on its own', async () => {
    const dto = await rest(2);
    setDeps({
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const row = await sync(dto.id, `run-${kit.org.id.slice(-6)}-2`);
    expect(row?.error_detail ?? '').not.toContain('MAX_PAGES');
  });
});
