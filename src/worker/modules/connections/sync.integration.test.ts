import { beforeAll, describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { type Kit as PassKit, setupKit } from '../passes/test-kit.ts';
import { resetDeps, setDeps } from './deps.ts';
import * as service from './service.ts';
import { executeSync } from './sync-runner.ts';
import { inlineStep, publicResolver } from './test-kit.ts';

/** sync -> records.applyIncoming -> real passes seams -> publishPass -> outbox, nothing faked. */
let kit: PassKit;
beforeAll(async () => {
  kit = await setupKit();
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
});

let n = 0;
async function sync(connectionId: string, generation: number) {
  const id = `int-${++n}`;
  await executeSync(kit.ctx, inlineStep(), {
    connectionId,
    generation,
    trigger: 'schedule',
    runId: id,
    instanceId: id,
  });
  return id;
}

describe('connection sync through the real pass seams', () => {
  it('creates passes, bumps versions with cause connection, queues pushes, and is idempotent', async () => {
    const actor = { type: 'user', id: 'admin-1' } as const;
    const dto = await service.create(kit.ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 2 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);

    const created = await sync(dto.id, 1);
    await kit.settle();
    const rows = await all<{ id: string; version: number; external_ref: string }>(
      kit.env.DB,
      'SELECT id, version, external_ref FROM passes WHERE connection_id = ? ORDER BY external_ref',
      [dto.id],
    );
    expect(rows.map((r) => r.external_ref)).toEqual(['m-001', 'm-002']);
    expect(await runOf(created)).toEqual({ passes_changed: 2, outcome: 'changed' });

    // Editing the mapping and config bumps the generation and restarts the listing.
    await service.update(kit.ctx, actor, dto.id, {
      mapping: { memberName: { from: '/memberName', transform: { kind: 'upper' } } },
      config: { count: 2, revision: 1 },
    });
    const updated = await sync(dto.id, 2);
    await kit.settle();
    for (const row of rows) {
      const now = await first<{ version: number; personalization: string }>(
        kit.env.DB,
        'SELECT version, personalization FROM passes WHERE id = ?',
        [row.id],
      );
      expect(now?.version).toBe(row.version + 1);
      expect(JSON.parse(now?.personalization ?? '{}').memberName).toBe(
        `MEMBER ${row.external_ref.toUpperCase()}`,
      );
      const latest = await first<{ cause: string }>(
        kit.env.DB,
        'SELECT cause FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
        [row.id],
      );
      expect(latest?.cause).toBe('connection');
      const pushes = await all(
        kit.env.DB,
        "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'push'",
        [row.id],
      );
      expect(pushes.length).toBeGreaterThanOrEqual(1);
    }
    expect(await runOf(updated)).toEqual({ passes_changed: 2, outcome: 'changed' });

    // Same upstream data: no further versions.
    const again = await sync(dto.id, 2);
    expect(await runOf(again)).toEqual({ passes_changed: 0, outcome: 'unchanged' });
    const after = await all<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM passes WHERE connection_id = ? ORDER BY external_ref',
      [dto.id],
    );
    expect(after.map((r) => r.version)).toEqual(rows.map((r) => r.version + 1));
  });
});

const runOf = (id: string) =>
  first<{ passes_changed: number; outcome: string }>(
    kit.env.DB,
    'SELECT passes_changed, outcome FROM connection_runs WHERE id = ?',
    [id],
  );
