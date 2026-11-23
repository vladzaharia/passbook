import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { all, first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { BOUNDARY_BATCH, refreshAtBoundaries } from './event-boundaries.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit({
    template: (id) => {
      const registry = new InMemoryTemplateRegistry();
      const resolved = registry.add({
        id,
        orgId: null,
        version: 'v1',
        manifest: {
          schema: 1,
          name: 'Season',
          inputs: {
            type: 'object',
            required: ['memberName'],
            properties: {
              memberName: { type: 'string', minLength: 1 },
              events: { type: 'array', items: { type: 'object' } },
            },
          },
          sample: { memberName: 'Alex Morgan' },
          bindings: [{ to: { field: 'name' }, value: '{{memberName}}' }],
          display: { title: '{{memberName}}' },
          behaviors: [{ use: 'upcoming-events', version: 1, config: { input: 'events' } }],
        },
        passJson: {
          formatVersion: 1,
          passTypeIdentifier: 'placeholder',
          teamIdentifier: 'placeholder',
          serialNumber: 'placeholder',
          organizationName: 'placeholder',
          description: 'Test pass',
          generic: { primaryFields: [{ key: 'name', label: 'Member', value: '' }] },
        } as PassJson,
        assets: { 'icon.png': ICON_PNG },
      });
      return { resolved, registry };
    },
  });
});

const events = (...rows: [string, number, number?][]) =>
  rows.map(([name, start, end]) => ({
    name,
    startsAt: iso(start),
    ...(end ? { endsAt: iso(end) } : {}),
  }));

/** A pass whose event list is set, settled to its first boundary. */
async function seasonPass(
  list: ReturnType<typeof events>,
  scope: { orgId?: string; mode?: 'live' | 'test' } = {},
) {
  const created = await kit.pass(scope);
  await publishPass(jobCtxOf(kit), {
    passId: created.id,
    cause: 'admin',
    actor: { type: 'system', id: null },
    mutate: () => ({ personalization: { memberName: 'Alex Morgan', events: list } }),
  });
  await kit.settle();
  return created;
}

const rowOf = (passId: string) =>
  first<{ due_at: number }>(kit.env.DB, 'SELECT due_at FROM pass_boundaries WHERE pass_id = ?', [
    passId,
  ]);
/** Marks the pass's earlier pushes as sent, so a later one is a new row, not a coalesced one. */
const clearPushes = (passId: string) =>
  kit.env.DB.prepare(
    "UPDATE outbox SET state = 'sent', coalesce_key = NULL WHERE pass_id = ? AND kind = 'push'",
  )
    .bind(passId)
    .run();
const pendingPushes = async (passId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'push' AND state != 'sent'",
      [passId],
    )
  )?.n ?? 0;
const versions = async (passId: string) => (await getPass(kit.env.DB, passId))?.version ?? 0;
const latest = async (passId: string) => {
  const row = await first<{ pass_json: string }>(
    kit.env.DB,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return JSON.parse(row?.pass_json ?? '{}') as PassJson;
};
const activeNames = async (passId: string) =>
  (((await latest(passId)).upcomingPassInformation ?? []) as { name: string; isActive: boolean }[])
    .filter((e) => e.isActive)
    .map((e) => e.name);

describe('timed refresh at event boundaries', () => {
  it('schedules the first boundary after the version was built', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(events(['A', now + 2 * HOUR, now + 3 * HOUR]));
    expect(await rowOf(pass.id)).toEqual({ due_at: 0 });
    await refreshAtBoundaries(jobCtxOf(kit));
    expect(await rowOf(pass.id)).toEqual({ due_at: now + 2 * HOUR });
  });

  it('rebuilds at the start and the end, pushing the devices each time', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(
      events(['A', now + 2 * HOUR, now + 3 * HOUR], ['B', now + 5 * HOUR, now + 6 * HOUR]),
    );
    await kit.device(pass, 'dev-start', 'b'.repeat(64));
    await refreshAtBoundaries(jobCtxOf(kit));
    const before = await versions(pass.id);
    expect(await activeNames(pass.id)).toEqual([]);

    kit.clock.set(now + 2 * HOUR);
    await clearPushes(pass.id);
    await refreshAtBoundaries(jobCtxOf(kit));
    await kit.settle();
    expect(await versions(pass.id)).toBe(before + 1);
    expect(await activeNames(pass.id)).toEqual(['A']);
    expect(await pendingPushes(pass.id)).toBe(1);
    expect(await rowOf(pass.id)).toEqual({ due_at: 0 });

    await refreshAtBoundaries(jobCtxOf(kit));
    expect(await rowOf(pass.id)).toEqual({ due_at: now + 3 * HOUR + 1 });

    kit.clock.set(now + 3 * HOUR + 1);
    await clearPushes(pass.id);
    await refreshAtBoundaries(jobCtxOf(kit));
    await kit.settle();
    expect(await activeNames(pass.id)).toEqual([]);
    expect(await versions(pass.id)).toBe(before + 2);
    expect(await pendingPushes(pass.id)).toBe(1);
    const names = ((await latest(pass.id)).upcomingPassInformation ?? []) as { name: string }[];
    expect(names.map((e) => e.name)).toEqual(['B']);
  });

  it('is idempotent: a second tick at the same time does nothing', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(events(['A', now + HOUR, now + 2 * HOUR]));
    await refreshAtBoundaries(jobCtxOf(kit));
    kit.clock.set(now + HOUR);
    await refreshAtBoundaries(jobCtxOf(kit));
    const after = await versions(pass.id);
    await clearPushes(pass.id);
    await refreshAtBoundaries(jobCtxOf(kit));
    await refreshAtBoundaries(jobCtxOf(kit));
    await kit.settle();
    expect(await versions(pass.id)).toBe(after);
    expect(await pendingPushes(pass.id)).toBe(0);
  });

  it('publishes and pushes nothing when the rebuild changes nothing', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(events(['A', now + 4 * HOUR, now + 5 * HOUR]));
    await kit.device(pass, 'dev-same', 'c'.repeat(64));
    await refreshAtBoundaries(jobCtxOf(kit));
    const before = await versions(pass.id);
    // Due early with the clock still before the start: the built pass is identical.
    await kit.env.DB.prepare('UPDATE pass_boundaries SET due_at = ? WHERE pass_id = ?')
      .bind(kit.clock.now(), pass.id)
      .run();
    await clearPushes(pass.id);
    await refreshAtBoundaries(jobCtxOf(kit));
    await kit.settle();
    expect(await versions(pass.id)).toBe(before);
    expect(await pendingPushes(pass.id)).toBe(0);
    expect(await rowOf(pass.id)).toEqual({ due_at: now + 4 * HOUR });
  });

  it('drops the row once the last event is over', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(events(['A', now + HOUR, now + 2 * HOUR]));
    await refreshAtBoundaries(jobCtxOf(kit));
    kit.clock.set(now + HOUR);
    await refreshAtBoundaries(jobCtxOf(kit));
    await refreshAtBoundaries(jobCtxOf(kit));
    kit.clock.set(now + 2 * HOUR + 1);
    await refreshAtBoundaries(jobCtxOf(kit));
    await refreshAtBoundaries(jobCtxOf(kit));
    expect(await rowOf(pass.id)).toBeNull();
  });

  it('refreshes each organization and mode under its own scope, and skips voided passes', async () => {
    const now = kit.clock.now();
    const other = await makeOrg(kit.fx, { name: 'Other Gym' });
    await approveAppleRelease(kit, { orgId: other.id });
    await approveAppleRelease(kit, { orgId: other.id, mode: 'test' });
    const list = events(['A', now + HOUR, now + 2 * HOUR]);
    const mine = await seasonPass(list);
    const theirs = await seasonPass(list, { orgId: other.id });
    const test = await seasonPass(list, { orgId: other.id, mode: 'test' });
    const voided = await seasonPass(list);
    await publishPass(jobCtxOf(kit), {
      passId: voided.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      mutate: () => ({ status: 'voided' }),
    });
    await refreshAtBoundaries(jobCtxOf(kit));
    kit.clock.set(now + HOUR);
    await refreshAtBoundaries(jobCtxOf(kit));
    for (const p of [mine, theirs, test]) expect(await activeNames(p.id)).toEqual(['A']);
    expect((await getPass(kit.env.DB, test.id))?.mode).toBe('test');
    expect(await rowOf(voided.id)).toBeNull();
  });

  it('handles at most one batch a tick and finishes the rest on the next', async () => {
    const now = kit.clock.now();
    await kit.env.DB.prepare('DELETE FROM pass_boundaries').run();
    const passes = [];
    for (let i = 0; i < BOUNDARY_BATCH + 5; i++)
      passes.push(await seasonPass(events(['A', now + HOUR, now + 2 * HOUR])));
    await refreshAtBoundaries(jobCtxOf(kit));
    const unsettled = () =>
      first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM pass_boundaries WHERE due_at = 0',
      );
    expect((await unsettled())?.n).toBe(5);
    await refreshAtBoundaries(jobCtxOf(kit));
    expect((await unsettled())?.n).toBe(0);

    kit.clock.set(now + HOUR);
    const ids = passes.map((p) => p.id);
    const versionsOf = async () =>
      (
        await all<{ version: number }>(
          kit.env.DB,
          `SELECT version FROM passes WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
          ids,
        )
      ).map((r) => r.version);
    const start = await versionsOf();
    await refreshAtBoundaries(jobCtxOf(kit));
    const after = await versionsOf();
    const bumped = after.filter((v, i) => v !== start[i]).length;
    expect(bumped).toBe(BOUNDARY_BATCH);
  });
});
