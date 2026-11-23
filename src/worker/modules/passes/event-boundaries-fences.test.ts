import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { runBulkChunk } from './bulk-run-chunk.ts';
import {
  events,
  fenced,
  HOUR,
  rowOf,
  seasonKit,
  seasonPass,
  stampRender,
  tick,
} from './event-boundaries-test-fixtures.ts';
import { HEAD, type ImportHarness, setupImportHarness, stepOf } from './import-test-fixtures.ts';
import type { Kit } from './pass-test-fixtures.ts';
import type { Pass } from './repo-map.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';

describe('version fences after an event boundary renders the pass', () => {
  let kit: Kit;
  let auth: TenantTestAuth;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    kit = await seasonKit();
    auth = await setupTenantTestAuth(kit);
    app = createApp({ stores: auth.stores, clock: kit.clock });
  });
  const call = (method: string, path: string, body?: unknown, headers = {}) =>
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method,
        headers: { ...auth.admin(), 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );

  /**
   * Passes whose event starts two seconds from now, inside the job's clock margin; `cross` runs the
   * minute hook, which renders them as running. The clock stays put, so sessions stay valid.
   */
  async function passes(prefix: string, count: number) {
    const now = kit.clock.now();
    const list: Pass[] = [];
    for (let i = 0; i < count; i++)
      list.push(
        await seasonPass(kit, events(['Show', now + 2000, now + HOUR]), {
          memberName: `${prefix} ${i}`,
          holderEmail: `${prefix.toLowerCase()}${i}@example.com`,
        }),
      );
    const cross = async () => {
      const before = await Promise.all(list.map((p) => fenced(kit, p.id)));
      await tick(kit);
      for (const [i, p] of list.entries()) {
        expect((await rowOf(kit, p.id))?.rendered_at).toBeGreaterThan(0);
        expect(await fenced(kit, p.id)).toEqual(before[i]);
      }
    };
    return { list, cross };
  }

  it('a console save with If-Match the version read before the boundary', async () => {
    const { list, cross } = await passes('Save', 1);
    const [pass] = list;
    await cross();
    const res = await call(
      'PATCH',
      `/passes/${pass?.id}`,
      { input: { memberName: 'Save Edited' } },
      { 'if-match': `"${pass?.version}"` },
    );
    expect(res.status, await res.clone().text()).toBe(200);
  });

  for (const action of ['void', 'remove', 'send_email'] as const)
    it(`a bulk ${action} run started before the boundary`, async () => {
      const prefix = `Bulk${action.replace('_', '')}`;
      const { cross } = await passes(prefix, 2);
      const res = await call('POST', '/passes/bulk-runs', {
        action,
        orgId: kit.org.id,
        selection: {
          filter: { match: [{ input: 'memberName', op: 'startsWith', value: prefix }] },
          expectCount: 2,
        },
      });
      expect(res.status, await res.clone().text()).toBe(202);
      const started = (await res.json()) as { id: string };
      await cross();
      await runBulkChunk(jobCtxOf(kit), started.id);
      const run = (await (
        await call('GET', `/passes/bulk-runs/${started.id}?orgId=${kit.org.id}`)
      ).json()) as { state: string; done: number; skipped: number };
      expect(run).toMatchObject({ state: 'done', done: 2, skipped: 0 });
    });
});

describe('import fences after an event boundary renders the pass', () => {
  let h: ImportHarness;
  beforeAll(async () => {
    h = await setupImportHarness();
  });
  const byExternal = (externalId: string) =>
    first<{ id: string; personalization: string; removed_at: number | null }>(
      h.kit.env.DB,
      'SELECT id, personalization, removed_at FROM passes WHERE org_id = ? AND external_id = ?',
      [h.kit.org.id, externalId],
    );

  it('applies a check made before the boundary, then undoes it after another', async () => {
    const old = await h.existing('B-OLD', { memberName: 'Old', points: 1 });
    const draft = await h.draft([HEAD, 'Newer,2,,B-OLD', 'Fresh,1,,B-NEW'].join('\n'));
    await stampRender(h.kit.env, h.kit.clock, old.id);
    expect((await h.commit(draft.id)).status).toBe(200);
    await h.runWorkflow(draft.id);
    expect((await byExternal('B-OLD'))?.personalization).toContain('Newer');
    expect(await h.get(draft.id)).toMatchObject({ state: 'done' });

    const created = await byExternal('B-NEW');
    for (const id of [old.id, created?.id ?? '']) await stampRender(h.kit.env, h.kit.clock, id);
    expect((await h.api(h.admin, 'POST', `/${draft.id}/undo`, {})).status).toBe(200);
    const instance = await first<{ undo_instance: string }>(
      h.kit.env.DB,
      'SELECT undo_instance FROM pass_imports WHERE id = ?',
      [draft.id],
    );
    await runPassImport(
      h.kit.env,
      instance?.undo_instance ?? '',
      { importId: draft.id, orgId: h.kit.org.id, mode: 'live', undo: true },
      stepOf(),
    );
    expect((await byExternal('B-OLD'))?.personalization).toContain('Old');
    expect((await byExternal('B-NEW'))?.removed_at).not.toBeNull();
  });
});
