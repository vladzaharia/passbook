import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { writeScope } from '../settings/repo.ts';
import { clearSettingsCache, updateSettings } from '../settings/service.ts';
import { orgRetention, retentionPlan } from './plan.ts';
import { DAY } from './policy.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
afterEach(async () => {
  await run(
    rk.kit.env.DB,
    "DELETE FROM settings WHERE scope = 'platform' AND key LIKE 'retention.%'",
  );
  clearSettingsCache(rk.kit.env.DB);
  rk.mail.length = 0;
  rk.kit.queue.sent.length = 0;
});

const ctx = () => rk.kit.ctx;
type OrgFx = Awaited<ReturnType<RetentionKit['org']>>;
const orgSave = (o: OrgFx, values: Record<string, unknown>, configRevision?: number) =>
  updateSettings(
    ctx(),
    { type: 'user', id: o.userId },
    { scope: `org:${o.orgId}`, values, configRevision },
    o.authority,
  );
const platformSave = async (values: Record<string, unknown>) => {
  const admin = await rk.platform();
  return updateSettings(
    ctx(),
    { type: 'user', id: admin.userId },
    { scope: 'platform', values },
    undefined,
    admin,
  );
};
/** Stores an org value as if it had been there for a while: no floor. */
const setRaw = (orgId: string, json: string, key = 'retention.scansDays') =>
  run(
    rk.kit.env.DB,
    'INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value',
    [`org:${orgId}`, key, json],
  ).then(() => clearSettingsCache(rk.kit.env.DB));
const floorsOf = (orgId: string) =>
  all<{ class: string; days: number; until: number }>(
    rk.kit.env.DB,
    'SELECT class, days, until FROM retention_floors WHERE org_id = ? ORDER BY class',
    [orgId],
  );
const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (error: unknown) =>
      error as { status: number; code: string; issues?: { path: string; code?: string }[] },
  );
  if (!e) throw new Error('expected a rejection');
  return e;
};
const scansDecision = async (orgId: string) => (await orgRetention(ctx(), orgId)).scans;

describe('bounds', () => {
  it('rejects an org value above the platform maximum and writes nothing', async () => {
    const o = await rk.org();
    const e = await rejection(orgSave(o, { 'retention.scansDays': 2000 }));
    expect(e).toMatchObject({ status: 422, code: 'RETENTION_ABOVE_MAX' });
    expect(e.issues?.[0]).toMatchObject({
      path: 'retention.scansDays',
      code: 'RETENTION_ABOVE_MAX',
    });
    expect(
      await all(rk.kit.env.DB, 'SELECT 1 FROM settings WHERE scope = ?', [`org:${o.orgId}`]),
    ).toHaveLength(0);
  });

  it('follows a lowered platform maximum', async () => {
    await platformSave({ 'retention.scansMaxDays': 365, 'retention.scansDays': 300 });
    const o = await rk.org();
    expect(await rejection(orgSave(o, { 'retention.scansDays': 400 }))).toMatchObject({
      code: 'RETENTION_ABOVE_MAX',
    });
    await orgSave(o, { 'retention.scansDays': 365 });
    expect(await scansDecision(o.orgId)).toMatchObject({ kind: 'run', days: 365, source: 'org' });
  });

  it('rejects values outside the class floor and ceiling before any cross check', async () => {
    const o = await rk.org();
    for (const days of [29, 3651, 90.5])
      expect(await rejection(orgSave(o, { 'retention.scansDays': days }))).toMatchObject({
        code: 'INVALID_SETTING',
      });
  });

  it('rejects a platform default above its maximum', async () => {
    expect(await rejection(platformSave({ 'retention.scansMaxDays': 100 }))).toMatchObject({
      status: 422,
      code: 'RETENTION_DEFAULT_ABOVE_MAX',
    });
    expect(await rejection(platformSave({ 'retention.scansDays': 2000 }))).toMatchObject({
      code: 'RETENTION_DEFAULT_ABOVE_MAX',
    });
    // Both in one save is fine.
    await platformSave({ 'retention.scansMaxDays': 100, 'retention.scansDays': 60 });
  });

  it('rejects an audit retention below 365 days', async () => {
    expect(await rejection(platformSave({ 'retention.auditDays': 90 }))).toMatchObject({
      code: 'INVALID_SETTING',
    });
  });
});

describe('shortening', () => {
  it('keeps the old days for 7 days, audits the floor and emails the admins', async () => {
    const o = await rk.org();
    await orgSave(o, { 'retention.scansDays': 800 });
    expect(await floorsOf(o.orgId)).toEqual([]);
    expect(rk.mail).toHaveLength(0);

    const now = rk.kit.clock.now();
    await orgSave(o, { 'retention.scansDays': 90 });
    expect(await floorsOf(o.orgId)).toEqual([{ class: 'scans', days: 800, until: now + 7 * DAY }]);
    expect(await scansDecision(o.orgId)).toEqual({
      kind: 'run',
      days: 800,
      source: 'org',
      pendingShorterFrom: now + 7 * DAY,
    });
    const audit = await first<{ detail: string }>(
      rk.kit.env.DB,
      "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'settings.update' ORDER BY id DESC LIMIT 1",
      [o.orgId],
    );
    expect(JSON.parse(audit?.detail ?? '{}').retentionFloors).toEqual([
      { orgId: o.orgId, cls: 'scans', days: 800, until: now + 7 * DAY },
    ]);
    expect(rk.mail).toHaveLength(0);
    expect(await rk.drain()).toBe(1);
    expect(rk.mail).toHaveLength(1);
    expect(rk.mail[0]).toMatchObject({ to: o.email });
    expect(rk.mail[0]?.subject).toContain('90 days');
    expect(rk.mail[0]?.text).toContain('Change it back in Settings');

    rk.kit.clock.advance(7 * DAY + 1);
    expect(await scansDecision(o.orgId)).toEqual({ kind: 'run', days: 90, source: 'org' });
  });

  it('a lengthening writes no floor and sends no email', async () => {
    const o = await rk.org();
    await orgSave(o, { 'retention.scansDays': 90 });
    rk.mail.length = 0;
    rk.kit.queue.sent.length = 0;
    await orgSave(o, { 'retention.scansDays': 500 });
    expect(await floorsOf(o.orgId)).toEqual([]);
    expect(await rk.drain()).toBe(0);
    expect(rk.mail).toHaveLength(0);
  });

  it('restoring the old value deletes the floor', async () => {
    const o = await rk.org();
    await orgSave(o, { 'retention.scansDays': 800 });
    await orgSave(o, { 'retention.scansDays': 90 });
    expect(await floorsOf(o.orgId)).toHaveLength(1);
    await orgSave(o, { 'retention.scansDays': 800 });
    expect(await floorsOf(o.orgId)).toEqual([]);
    expect(await scansDecision(o.orgId)).toMatchObject({ days: 800 });
  });

  it('resetting to a shorter platform default also waits', async () => {
    const o = await rk.org();
    await orgSave(o, { 'retention.scansDays': 800 });
    await orgSave(o, { 'retention.scansDays': null });
    expect(await floorsOf(o.orgId)).toMatchObject([{ class: 'scans', days: 800 }]);
    expect(await scansDecision(o.orgId)).toMatchObject({ days: 800, source: 'platform' });
  });

  it('a stale save fails whole: neither the value nor the floor is written', async () => {
    const o = await rk.org();
    await orgSave(o, { 'retention.scansDays': 800 });
    const revision = (
      await first<{ config_revision: number }>(
        rk.kit.env.DB,
        'SELECT config_revision FROM orgs WHERE id = ?',
        [o.orgId],
      )
    )?.config_revision;
    await orgSave(o, { 'branding.accent': '#123456' });
    expect(await rejection(orgSave(o, { 'retention.scansDays': 90 }, revision))).toMatchObject({
      status: 409,
    });
    expect(await floorsOf(o.orgId)).toEqual([]);
    expect(await scansDecision(o.orgId)).toMatchObject({ days: 800 });
  });

  it('a platform maximum drop writes floors for the orgs it shortens, and only those', async () => {
    const [a, b, c] = [await rk.org(), await rk.org(), await rk.org()];
    await setRaw(a.orgId, '1000');
    await setRaw(b.orgId, '90');
    rk.mail.length = 0;
    await platformSave({ 'retention.scansMaxDays': 500 });
    expect(await floorsOf(a.orgId)).toMatchObject([{ class: 'scans', days: 1000 }]);
    expect(await floorsOf(b.orgId)).toEqual([]);
    expect(await floorsOf(c.orgId)).toEqual([]);
    // One queued notice per org and class, no mail in the request.
    expect(rk.mail).toHaveLength(0);
    const queued = rk.kit.queue.sent.map((m) => (m as { orgId: string }).orgId);
    expect(queued.filter((id) => id === a.orgId)).toHaveLength(1);
    expect(queued).not.toContain(b.orgId);
    await rk.drain();
    expect(rk.mail.map((m) => m.to)).toContain(a.email);
    expect(rk.mail.map((m) => m.to)).not.toContain(b.email);
    expect(await scansDecision(a.orgId)).toMatchObject({
      days: 1000,
      pendingShorterFrom: expect.any(Number),
    });
  });

  it('a platform default drop floors the orgs that follow it', async () => {
    const [own, follower] = [await rk.org(), await rk.org()];
    await setRaw(own.orgId, '60');
    await platformSave({ 'retention.scansDays': 100 });
    expect(await floorsOf(follower.orgId)).toMatchObject([{ class: 'scans', days: 396 }]);
    expect(await floorsOf(own.orgId)).toEqual([]);
    expect(await scansDecision(follower.orgId)).toMatchObject({ days: 396 });
  });
});

describe('retentionPlan', () => {
  const planOf = async (cls: 'scans' | 'events' = 'scans') => {
    const plan = await retentionPlan(ctx(), cls);
    if (plan.blocked) throw new Error('blocked');
    return plan;
  };

  it('an invalid stored org value skips that org and never falls back to the default', async () => {
    const [good, bad, junk] = [await rk.org(), await rk.org(), await rk.org()];
    await setRaw(good.orgId, '60');
    await setRaw(bad.orgId, '5');
    await setRaw(junk.orgId, '"90"');
    const plan = await planOf();
    expect(plan.special.find((s) => s.orgId === good.orgId)?.days).toBe(60);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { orgId: bad.orgId, reason: 'invalid' },
        { orgId: junk.orgId, reason: 'invalid' },
      ]),
    );
    expect(plan.special.map((s) => s.orgId)).not.toContain(bad.orgId);
  });

  it('an invalid platform value blocks the class and leaves other classes alone', async () => {
    await run(
      rk.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'retention.scansDays', '1', 1)",
    );
    expect(await retentionPlan(ctx(), 'scans')).toMatchObject({ blocked: true });
    expect((await retentionPlan(ctx(), 'events')).blocked).toBe(false);
  });

  it('an org-wide hold skips the org for every class; a released one does not', async () => {
    const o = await rk.org();
    const admin = await rk.platform();
    const { placeHold, releaseHold } = await import('./holds.ts');
    const { id } = await placeHold(
      ctx(),
      o.orgId,
      { reason: 'inquiry' },
      { kind: 'platform', admin },
    );
    for (const cls of ['scans', 'events'] as const)
      expect((await planOf(cls)).skipped).toContainEqual({ orgId: o.orgId, reason: 'hold' });
    await releaseHold(ctx(), o.orgId, id, { kind: 'platform', admin });
    for (const cls of ['scans', 'events'] as const)
      expect((await planOf(cls)).skipped.map((s) => s.orgId)).not.toContain(o.orgId);
  });

  it('deleted orgs are left out, suspended orgs still run', async () => {
    const [gone, paused] = [await rk.org(), await rk.org()];
    await setRaw(gone.orgId, '60');
    await setRaw(paused.orgId, '60');
    await run(rk.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [paused.orgId]);
    await run(rk.kit.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [gone.orgId]);
    const ids = (await planOf()).special.map((s) => s.orgId);
    expect(ids).toContain(paused.orgId);
    expect(ids).not.toContain(gone.orgId);
  });

  it("one org's value never moves another org's cutoff", async () => {
    const [a, b] = [await rk.org(), await rk.org()];
    await setRaw(a.orgId, '60');
    const plan = await planOf();
    expect(plan.special.map((s) => s.orgId)).toContain(a.orgId);
    expect(plan.special.map((s) => s.orgId)).not.toContain(b.orgId);
    expect(await scansDecision(b.orgId)).toMatchObject({ days: 396, source: 'platform' });
  });

  it('reports the days a hold suspends when asked, for the about page', async () => {
    const o = await rk.org();
    await setRaw(o.orgId, '120');
    const admin = await rk.platform();
    const { placeHold } = await import('./holds.ts');
    await placeHold(ctx(), o.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    expect(await scansDecision(o.orgId)).toEqual({ kind: 'skip', reason: 'hold' });
    expect((await orgRetention(ctx(), o.orgId, true)).scans).toMatchObject({
      kind: 'run',
      days: 120,
    });
  });
});

describe('review fixes', () => {
  const migration = async (match: RegExp) => {
    const all0101 = (env.TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) =>
      m.name.includes('0101'),
    );
    return (all0101?.queries ?? []).filter((q) => match.test(q));
  };
  const putPlatform = (key: string, json: string) =>
    run(
      rk.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', ?, ?, 1)",
      [key, json],
    );

  it('H1: a stored default above the new table maximum is kept by seeding its maximum', async () => {
    await putPlatform('retention.scansDays', '3650');
    await putPlatform('retention.eventsDays', '900');
    await putPlatform('retention.auditDays', '90');
    for (const q of await migration(/MaxDays|auditDays/)) await run(rk.kit.env.DB, q);
    const rows = await all<{ key: string; value: string }>(
      rk.kit.env.DB,
      "SELECT key, value FROM settings WHERE scope = 'platform' AND key LIKE 'retention.%' ORDER BY key",
    );
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toMatchObject({
      'retention.scansMaxDays': '3650',
      'retention.eventsMaxDays': '900',
      'retention.auditDays': '365',
    });
    const plan = await retentionPlan(ctx(), 'scans');
    if (plan.blocked) throw new Error('blocked');
    expect(plan.platformDays).toBe(3650);
    const events = await retentionPlan(ctx(), 'events');
    if (events.blocked) throw new Error('blocked');
    expect(events.platformDays).toBe(900);
  });

  it('H1: defaults within the table maximum seed nothing', async () => {
    await putPlatform('retention.scansDays', '500');
    for (const q of await migration(/MaxDays/)) await run(rk.kit.env.DB, q);
    expect(
      await all(
        rk.kit.env.DB,
        "SELECT 1 FROM settings WHERE scope = 'platform' AND key = 'retention.scansMaxDays'",
      ),
    ).toHaveLength(0);
  });

  it('M1: fixing an invalid org value floors at the platform maximum, not at nothing', async () => {
    const o = await rk.org();
    await setRaw(o.orgId, '5');
    expect(await scansDecision(o.orgId)).toEqual({ kind: 'skip', reason: 'invalid' });
    await orgSave(o, { 'retention.scansDays': 60 });
    expect(await floorsOf(o.orgId)).toMatchObject([{ class: 'scans', days: 1095 }]);
    expect(await scansDecision(o.orgId)).toMatchObject({ days: 1095 });
  });

  it('M1: fixing an invalid platform value floors every org at the ceiling', async () => {
    const o = await rk.org();
    await putPlatform('retention.scansDays', '1');
    await platformSave({ 'retention.scansDays': 100 });
    expect(await floorsOf(o.orgId)).toMatchObject([{ class: 'scans', days: 3650 }]);
  });

  it('L1: a platform save moves the config revision of the orgs it floors, so a stale org save fails', async () => {
    const o = await rk.org();
    const rev = async () =>
      (
        await first<{ config_revision: number }>(
          rk.kit.env.DB,
          'SELECT config_revision FROM orgs WHERE id = ?',
          [o.orgId],
        )
      )?.config_revision;
    const before = await rev();
    await platformSave({ 'retention.scansDays': 100 });
    expect(await rev()).toBe((before ?? 0) + 1);
    expect(await rejection(orgSave(o, { 'retention.scansDays': null }, before))).toMatchObject({
      status: 409,
    });
  });

  it('L3: a save planned before a platform retention change fails, org and platform side', async () => {
    const o = await rk.org();
    const rev = async () =>
      (
        await first<{ rev: number }>(
          rk.kit.env.DB,
          'SELECT rev FROM retention_platform_rev WHERE id = 1',
        )
      )?.rev ?? 0;
    const planned = await rev();
    await platformSave({ 'retention.scansDays': 100 });
    expect(await rev()).toBeGreaterThan(planned);
    const config = (
      await first<{ config_revision: number }>(
        rk.kit.env.DB,
        'SELECT config_revision FROM orgs WHERE id = ?',
        [o.orgId],
      )
    )?.config_revision;
    const stale = writeScope(
      ctx(),
      `org:${o.orgId}`,
      { 'retention.scansDays': 60 },
      [],
      o.userId,
      config ?? 0,
      o.authority,
      undefined,
      [],
      planned,
    );
    await expect(stale).rejects.toMatchObject({ status: 409 });
    const admin = await rk.platform();
    await expect(
      writeScope(
        ctx(),
        'platform',
        { 'retention.scansDays': 50 },
        [],
        admin.userId,
        null,
        undefined,
        admin,
        [],
        planned,
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Read afresh, both commit.
    const now = await rev();
    expect(
      await writeScope(
        ctx(),
        'platform',
        { 'retention.scansDays': 50 },
        [],
        admin.userId,
        null,
        undefined,
        admin,
        [],
        now,
      ),
    ).toBe(true);
  });
});
