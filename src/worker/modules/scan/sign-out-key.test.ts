import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { key, setupTillKit } from './guard-api-key-test-fixtures.ts';
import { trackedZone, useKit } from './occupancy/whos-in-test-fixtures.ts';
import { insertType } from './tags-policy-test-fixtures.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
let seq = 0;
beforeAll(async () => {
  t = await setupTillKit();
  useKit(t.kit);
});

/** A guest pass holding a loaner, bound as an admin would leave it. */
async function lent() {
  const { kit } = t;
  const pass = await kit.scanPass(t.templateId);
  const typeId = await insertType(kit, kit.org.id, { use: 'visitor', scopes: 'pass' });
  const tagId = kit.fx.ids.id();
  const bindingId = kit.fx.ids.id();
  const ref = (++seq).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, created_at)
     VALUES (?, ?, 'live', ?, 'uid', ?, ?, ?)`,
    [tagId, kit.org.id, ref, typeId, ref.slice(0, 4).toUpperCase(), now],
  );
  await run(
    kit.env.DB,
    `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, source, bound_at, bound_by_type, bound_by, holder_generation)
     VALUES (?, ?, 'pass', ?, 'admin', ?, 'user', 'admin-1', 0)`,
    [bindingId, tagId, pass.id, now],
  );
  return { pass, bindingId };
}
const ended = (id: string) =>
  first<{ end_cause: string | null; ended_by_type: string | null; ended_by: string | null }>(
    t.kit.env.DB,
    'SELECT end_cause, ended_by_type, ended_by FROM tag_bindings WHERE id = ?',
    [id],
  );

describe('a key at a Desk terminal signs out', () => {
  it('collects the lent tag as the terminal', async () => {
    const k = await t.till();
    const { pass, bindingId } = await lent();
    const res = await t.call(k.headers, '/sign-out', {
      idempotencyKey: key(),
      passId: pass.id,
      tag: 'returned',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: pass.id, tag: 'returned' });
    expect(await ended(bindingId)).toEqual({
      end_cause: 'visitor_out',
      ended_by_type: 'scanner',
      ended_by: k.terminal.id,
    });
  });

  it('names the key in the audit row of a lost report', async () => {
    const k = await t.till();
    const { pass, bindingId } = await lent();
    const res = await t.call(k.headers, '/sign-out', {
      idempotencyKey: key(),
      passId: pass.id,
      tag: 'not_returned',
    });
    expect(res.status).toBe(200);
    const rows = await t.kit.env.DB.prepare(
      "SELECT detail FROM audit_log WHERE action = 'tag.lost' ORDER BY id DESC LIMIT 5",
    ).all<{ detail: string }>();
    const mine = rows.results
      .map((r) => JSON.parse(r.detail))
      .find((d) => d.bindingId === bindingId);
    expect(mine).toMatchObject({ viaKeyId: k.apiKey.id });
  });

  it('names the key in the mark-out row of a person still inside', async () => {
    const k = await t.till();
    const { pass } = await lent();
    const zone = await trackedZone();
    const at = t.kit.clock.now();
    const sessionId = t.kit.fx.ids.id();
    await run(
      t.kit.env.DB,
      `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
       SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify({ templateIds: [t.templateId] }), k.terminal.id],
    );
    await run(
      t.kit.env.DB,
      `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
       SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, k.terminal.id],
    );
    await run(
      t.kit.env.DB,
      'INSERT INTO scanning_session_zones (session_id, zone_id, sort) VALUES (?, ?, 0)',
      [sessionId, zone.id],
    );
    await run(
      t.kit.env.DB,
      `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at, last_scan_id)
       VALUES (?, ?, ?, 'in', 1, ?, ?, ?, 'seed')`,
      [pass.id, t.kit.org.id, `zone:${zone.id}`, at, at, at],
    );
    const res = await t.call(k.headers, '/sign-out', {
      idempotencyKey: key(),
      passId: pass.id,
      tag: 'none',
    });
    expect(res.status).toBe(200);
    const out = await first<{ detail: string }>(
      t.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'scan.mark_out' AND target_id = ?",
      [pass.id],
    );
    expect(JSON.parse(out?.detail ?? '{}')).toMatchObject({ viaKeyId: k.apiKey.id });
  });

  it("a key of another org does not reach this org's terminal", async () => {
    const other = await makeOrg(t.kit.fx);
    const foreign = await t.makeTerminal({ orgId: other.id, kind: 'terminal' });
    const mine = await t.till();
    const k = { headers: { ...mine.headers, 'x-passbook-device': foreign.id } };
    const { pass, bindingId } = await lent();
    const res = await t.call(k.headers, '/sign-out', {
      idempotencyKey: key(),
      passId: pass.id,
      tag: 'returned',
    });
    expect(res.status).toBe(404);
    expect((await ended(bindingId))?.end_cause).toBeNull();
  });

  it('a key without scans:write is refused', async () => {
    const k = await t.till({ scopes: ['passes:read'] });
    const { pass, bindingId } = await lent();
    const res = await t.call(k.headers, '/sign-out', {
      idempotencyKey: key(),
      passId: pass.id,
      tag: 'returned',
    });
    expect(res.status).toBe(403);
    expect((await ended(bindingId))?.end_cause).toBeNull();
  });
});
