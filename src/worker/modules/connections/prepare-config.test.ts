import { beforeEach, describe, expect, it, vi } from 'vitest';
import demo from '../../connectors/demo/index.ts';
import { run } from '../../platform/db.ts';
import { getConnection } from './repo.ts';
import * as service from './service.ts';
import { openUnsaved, testConfig } from './test-config.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
  // 03:00 UTC on 9 July is still 8 July in Los Angeles.
  kit.clock.set(Date.parse('2026-07-09T03:00:00Z'));
});

async function stored(id: string) {
  const row = await getConnection(kit.env.DB, id);
  if (!row) throw new Error('missing connection');
  return row.config as Record<string, unknown>;
}

const v2 = { dataset: 'gym-members', count: 3 };

function unsaved(config: Record<string, unknown>) {
  return { orgId: kit.org.id, connectorType: 'demo', config } as Parameters<typeof testConfig>[2];
}

describe('prepareConfig', () => {
  it('create stamps the org-local date, Pacific by default', async () => {
    const created = await createDemo(kit, { config: v2 });
    expect((await stored(created.id)).anchor).toBe('2026-07-08');
  });

  it('create uses the org time zone when it has one', async () => {
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', ?, 0)",
      [`org:${kit.org.id}`, JSON.stringify('Pacific/Auckland')],
    );
    const created = await createDemo(kit, { config: v2 });
    expect((await stored(created.id)).anchor).toBe('2026-07-09');
  });

  it('keeps an anchor the caller set, and leaves classic configs as they were', async () => {
    const set = await createDemo(kit, { config: { ...v2, anchor: '2030-01-02' } });
    expect((await stored(set.id)).anchor).toBe('2030-01-02');
    const classic = await createDemo(kit);
    expect((await stored(classic.id)).anchor).toBeUndefined();
  });

  it('update without an anchor keeps the stored one, even on another day', async () => {
    const created = await createDemo(kit, { config: v2 });
    kit.clock.set(Date.parse('2026-09-01T12:00:00Z'));
    await service.update(kit.sctx, kit.actor, created.id, { config: { ...v2, count: 5 } });
    const config = await stored(created.id);
    expect(config.anchor).toBe('2026-07-08');
    expect(config.count).toBe(5);
  });

  it('update with a new anchor moves it', async () => {
    const created = await createDemo(kit, { config: v2 });
    await service.update(kit.sctx, kit.actor, created.id, {
      config: { ...v2, anchor: '2027-02-03' },
    });
    expect((await stored(created.id)).anchor).toBe('2027-02-03');
  });

  it('an unsaved open and an unsaved test see the stamped anchor', async () => {
    const opened = await openUnsaved(kit.sctx, unsaved(v2));
    expect((opened.cc.connection.config as { anchor?: string }).anchor).toBe('2026-07-08');
    const seen: unknown[] = [];
    const spy = vi.spyOn(demo, 'test').mockImplementation(async (ctx) => {
      seen.push(ctx.connection.config);
      return { ok: true };
    });
    try {
      await testConfig(kit.sctx, kit.actor, unsaved(v2));
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect((seen[0] as { anchor?: string }).anchor).toBe('2026-07-08');
  });
});
