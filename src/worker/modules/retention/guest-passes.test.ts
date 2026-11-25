import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { dailyPasses } from '../passes/jobs.ts';
import { ACCESS, accessTemplate, grantOf, makeDoor } from '../scan/access-test-fixtures.ts';
import { CHECK_IN, HOUR, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { dailyGuestPasses } from './guest-passes.ts';

const DAY = 24 * HOUR;
let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate();
});
const ctx = () => createJobContext(kit.env, 'visitors', { clock: kit.clock });

/** A pass on `plan` whose own end is `endsIn` from now (default: now). */
const pass = (plan: string, endsIn = 0, orgId = kit.org.id, template = tpl) =>
  kit.scanPass(
    template,
    { plan, validUntil: new Date(kit.clock.now() + endsIn).toISOString() },
    { orgId },
  );
const gone = async (id: string) =>
  ((
    await first<{ d: number | null }>(
      kit.env.DB,
      'SELECT deleted_at AS d FROM passes WHERE id = ?',
      [id],
    )
  )?.d ?? null) !== null;
const hold = (orgId: string, passId: string | null) =>
  run(
    kit.env.DB,
    "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)",
    [kit.fx.ids.id(), orgId, passId],
  );
const receipts = (orgId: string | null) =>
  all<{ deleted: number; kind: string; policy_days: number }>(
    kit.env.DB,
    "SELECT deleted, kind, policy_days FROM retention_receipts WHERE class = 'visitors' AND org_id IS ? ORDER BY seq",
    [orgId],
  );

describe('guest-plan pass retention', () => {
  it('deletes a guest pass after its end plus the days, keeps it one hour before, with a receipt and a system audit row', async () => {
    const due = await pass('guest');
    const early = await pass('guest', 2 * HOUR);
    kit.clock.advance(90 * DAY + HOUR);
    await dailyGuestPasses(ctx());
    expect(await gone(due.id)).toBe(true);
    expect(await gone(early.id)).toBe(false);
    const found = await receipts(null);
    expect(found.at(-1)).toMatchObject({ deleted: 1, kind: 'visitor', policy_days: 90 });
    const audit = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'pass.delete' AND target_id = ? AND actor_type = 'system'",
      [due.id],
    );
    expect(audit?.n).toBe(1);
    kit.clock.advance(2 * HOUR);
    await dailyGuestPasses(ctx());
    expect(await gone(early.id)).toBe(true);
  });

  it('uses the org days when the org sets its own', async () => {
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'retention.visitorsDays', '10', 1)",
      [`org:${kit.org.id}`],
    );
    clearSettingsCache(kit.env.DB);
    const p = await pass('guest');
    kit.clock.advance(9 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(false);
    kit.clock.advance(2 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(true);
    expect((await receipts(kit.org.id)).at(-1)).toMatchObject({ deleted: 1, policy_days: 10 });
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'retention.visitorsDays'");
    clearSettingsCache(kit.env.DB);
  });

  it('never touches a member-plan pass, however old', async () => {
    const member = await pass('gold');
    const timed = await pass('off_peak');
    kit.clock.advance(500 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(member.id)).toBe(false);
    expect(await gone(timed.id)).toBe(false);
  });

  it('keeps a pass whose plan changed to a member plan or whose end was extended', async () => {
    const moved = await pass('guest');
    const extended = await pass('guest');
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.plan', 'gold') WHERE id = ?",
      [moved.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.validUntil', ?) WHERE id = ?",
      [new Date(kit.clock.now() + 200 * DAY).toISOString(), extended.id],
    );
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(moved.id)).toBe(false);
    expect(await gone(extended.id)).toBe(false);
  });

  it('keeps a pass under a pass hold or an org hold until the hold is released', async () => {
    const held = await pass('guest');
    const free = await pass('guest');
    await hold(kit.org.id, held.id);
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(held.id)).toBe(false);
    expect(await gone(free.id)).toBe(true);
    await run(
      kit.env.DB,
      'UPDATE retention_holds SET released_at = 2, released_by = ? WHERE pass_id = ?',
      ['p', held.id],
    );
    await hold(kit.org.id, null);
    await dailyGuestPasses(ctx());
    expect(await gone(held.id)).toBe(false);
    await run(
      kit.env.DB,
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
      [kit.org.id],
    );
    await dailyGuestPasses(ctx());
    expect(await gone(held.id)).toBe(true);
  });

  it('keeps a pass with a pending credential transfer', async () => {
    const moving = await pass('guest');
    await run(
      kit.env.DB,
      `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version,
         source_revision, source_row_version, source_lifecycle_generation, source_link_generation,
         target_holder_email, requested_by_type, requested_at)
       SELECT ?, id, org_id, mode, 'pending', credential_generation, 1, 0, row_version, lifecycle_generation,
         link_generation + 1, 'next@example.test', 'system', 1 FROM passes WHERE id = ?`,
      [kit.fx.ids.id(), moving.id],
    );
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(moving.id)).toBe(false);
  });

  it('keeps a pass until the end of an old visit row that runs later', async () => {
    const p = await pass('guest');
    const until = kit.clock.now() + 150 * DAY;
    await run(
      kit.env.DB,
      `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, created_at)
       VALUES (?, ?, 'live', ?, 'Leo', 'Ana', 'ana@host.test', 1, ?, 1)`,
      [kit.fx.ids.id(), kit.org.id, p.id, until],
    );
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(false);
    kit.clock.advance(141 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(true);
  });

  it('anonymises its scans when the pass is purged: counts and pass_ref stay, the pass link goes', async () => {
    const door = await makeDoor([tpl]);
    const p = await pass('guest', HOUR);
    expect((await grantOf(door.headers, p)).kind).toBe('ok');
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(true);
    kit.clock.advance(8 * DAY);
    await dailyPasses(kit.ctx);
    expect(await first(kit.env.DB, 'SELECT 1 AS x FROM passes WHERE id = ?', [p.id])).toBeNull();
    const scans = await all<{ pass_id: string | null; pass_ref: string | null }>(
      kit.env.DB,
      `SELECT s.pass_id, r.pass_ref FROM scans s JOIN scan_retention_proofs r ON r.scan_id = s.id
       WHERE s.org_id = ? AND s.pass_id IS NULL AND r.pass_ref IS NOT NULL`,
      [kit.org.id],
    );
    expect(scans.length).toBeGreaterThan(0);
  });

  it('is tenant-isolated: an org hold, days and passes stay in their own org', async () => {
    const other = await makeOrg(kit.fx);
    const otherTplOrg = await kit.scanTemplate(
      'Other org access',
      { actions: [CHECK_IN], access: ACCESS },
      { orgId: other.id },
    );
    const otherTpl = tpl;
    const mine = await pass('guest', 0, kit.org.id, otherTpl);
    const theirs = await pass('guest', 0, other.id, otherTplOrg);
    const theirsHeld = await pass('guest', 0, other.id, otherTplOrg);
    await hold(other.id, theirsHeld.id);
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(mine.id)).toBe(true);
    expect(await gone(theirs.id)).toBe(true);
    expect(await gone(theirsHeld.id)).toBe(false);
    const later = await pass('guest', 0, kit.org.id, otherTpl);
    const laterTheirs = await pass('guest', 0, other.id, otherTplOrg);
    await hold(other.id, null);
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(later.id)).toBe(true);
    expect(await gone(laterTheirs.id)).toBe(false);
  });
});
