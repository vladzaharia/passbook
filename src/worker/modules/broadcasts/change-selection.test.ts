import { beforeAll, describe, expect, it } from 'vitest';
import { changeRunDrifted } from '../../../shared/contracts/pass-selection.ts';
import { first, run } from '../../platform/db.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';
import { assertNotTooBroad } from './change-target.ts';

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

describe('change run selection', () => {
  it('allows the 2% a run can move between its count and its start', () => {
    expect(changeRunDrifted(1000, 1020)).toBe(false);
    expect(changeRunDrifted(1000, 980)).toBe(false);
    expect(changeRunDrifted(1000, 1021)).toBe(true);
    expect(changeRunDrifted(10, 11)).toBe(true);
  });

  it('refuses more than 20,000 passes with a coded error', () => {
    expect(() => assertNotTooBroad(20_000)).not.toThrow();
    expect(() => assertNotTooBroad(20_001)).toThrowError(/Narrow the filter/);
  });

  it('leaves out a pass whose credential is moving, as the list does', async () => {
    const a = await ck.kit.makePass();
    const b = await ck.kit.makePass();
    const db = ck.kit.env.DB;
    const row = await first<{ rv: number; cg: number; lg: number; lk: number }>(
      db,
      'SELECT row_version AS rv, credential_generation AS cg, lifecycle_generation AS lg, link_generation AS lk FROM passes WHERE id = ?',
      [b.id],
    );
    await run(
      db,
      `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision,
         source_row_version, source_lifecycle_generation, source_link_generation, target_holder_email,
         requested_by_type, requested_at) VALUES ('t-chg', ?, ?, 'live', 'pending', ?, 1, 0, ?, ?, ?, 'x@example.test', 'system', 1)`,
      [b.id, ck.kit.org.id, row?.cg, row?.rv, row?.lg, (row?.lk ?? 0) + 1],
    );
    const res = await ck.post('/broadcasts/preview', {
      orgId: ck.kit.org.id,
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { gate: { set: 'Z' } },
    });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as { targeted: number };
    const all = await first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM passes WHERE template_id = ? AND org_id = ? AND status = 'active' AND removed_at IS NULL",
      [ck.kit.messaging.id, ck.kit.org.id],
    );
    expect(preview.targeted).toBe((all?.n ?? 0) - 1);
    expect(a.id).not.toBe(b.id);
  });

  it('finds the undo run of a change by its parent', async () => {
    const a = await ck.kit.makePass({ gate: 'A' });
    const done = await ck.change({
      target: { passIds: [a.id] },
      patch: { gate: { set: 'Q' } },
      notify: false,
    });
    const undo = (await (await ck.post(`/broadcasts/${done.id}/undo`)).json()) as { id: string };
    const list = async (query: string) =>
      (
        (await (
          await ck.api(`/broadcasts?orgId=${ck.kit.org.id}&kind=change&${query}`, {
            headers: ck.auth.admin(),
          })
        ).json()) as {
          items: { id: string }[];
        }
      ).items.map((b) => b.id);
    expect(await list(`parentId=${done.id}`)).toEqual([undo.id]);
    expect(await list(`retryOf=${done.id}`)).toEqual([]);
  });

  it('cancels a scheduled change only with passes:write, like stop and undo', async () => {
    const a = await ck.kit.makePass();
    const at = ck.kit.clock.now() + 2 * 3_600_000;
    const made = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { passIds: [a.id] },
      patch: { gate: { set: 'S' } },
      notify: false,
      send: 'schedule',
      at,
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const noPass = await ck.auth.apiKey({ orgId: ck.kit.org.id, scopes: ['messages:write'] });
    const denied = await ck.post(`/broadcasts/${id}/cancel`, {}, noPass);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe('MISSING_SCOPE');
    const both = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:write', 'passes:write'],
    });
    expect((await ck.post(`/broadcasts/${id}/cancel`, {}, both)).status).toBe(200);
  });
});
