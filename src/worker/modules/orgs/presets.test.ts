import { describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OrgEntitlementsDto } from '../../../shared/contracts/entitlement-admin.ts';
import type {
  EntitlementPresetDto,
  SetEntitlementPresetResult,
} from '../../../shared/contracts/entitlement-presets.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all, first } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type ApplyKit, applyKit } from '../channels/apply-test-fixtures.ts';
import { handleEntitlementApply } from '../channels/entitlement-apply.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { expireEntitlementOverrides } from './entitlement-expiry.ts';
import { setPreset } from './presets-service.ts';

const json = { 'content-type': 'application/json' };
const PRESETS = '/platform/entitlement-presets';

const presetsOf = async (t: ApplyKit): Promise<EntitlementPresetDto[]> =>
  (
    (await (await t.kit.api(PRESETS, { headers: t.kit.auth.admin() })).json()) as {
      presets: EntitlementPresetDto[];
    }
  ).presets;
const putPreset = (
  t: ApplyKit,
  body: unknown,
  headers: Record<string, string> = t.kit.auth.admin(),
) =>
  t.kit.api(PRESETS, {
    method: 'PUT',
    headers: { ...headers, ...json },
    body: JSON.stringify(body),
  });
const jobs = (t: ApplyKit) =>
  (t.kit.queue.sent as { kind: string }[]).filter(
    (m) => m.kind === 'channel.entitlement',
  ) as JobOf<'channel.entitlement'>[];
const orgRow = (t: ApplyKit, orgId: string) =>
  first<{ revision: number; preset: string; preset_revision: number }>(
    t.kit.env.DB,
    'SELECT revision, preset, preset_revision FROM org_entitlements WHERE org_id = ?',
    [orgId],
  );
const orgAudit = (t: ApplyKit, orgId: string) =>
  all<{ actor_type: string; detail: string }>(
    t.kit.env.DB,
    "SELECT actor_type, detail FROM audit_log WHERE action = 'org.entitlements_update' AND org_id = ? ORDER BY id",
    [orgId],
  );

/** A platform admin whose session is live, for calling the service with a grant. */
async function liveAdmin(t: ApplyKit) {
  const user = await makeUser(t.kit.fx);
  const s = await makeSession(t.kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  const session = await createSessionStore(t.kit.env, t.kit.clock).resolve(s.cookieValue);
  if (!session) throw new Error('Session fixture missing');
  return { userId: user.id, sessionId: session.sessionId };
}

/** An organization moved onto `preset` through the platform API. */
async function orgOn(t: ApplyKit, preset: string): Promise<string> {
  const org = await makeOrg(t.kit.fx);
  const path = `/platform/orgs/${org.id}/entitlements`;
  const read = (await (
    await t.kit.api(path, { headers: t.kit.auth.admin() })
  ).json()) as OrgEntitlementsDto;
  const res = await t.kit.api(path, {
    method: 'PUT',
    headers: { ...t.kit.auth.admin(), ...json },
    body: JSON.stringify({ preset, expectedRevision: read.revision, overrides: {} }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return org.id;
}

/** The trial preset as it stands now; the tests share one database, so each reads where it is. */
const trialOf = async (t: ApplyKit) => {
  const p = (await presetsOf(t)).find((x) => x.preset === 'trial') as EntitlementPresetDto;
  const google = p.values['wallet.google'] === 1;
  return { ...p, google, flipped: google ? 0 : 1, members: p.values.members as number };
};
const blocked = (
  j: JobOf<'channel.entitlement'> | undefined,
  side: 'blockedBefore' | 'blockedAfter',
) => j?.[side].includes('google');

describe('PUT /platform/entitlement-presets: authority', () => {
  it('is for a platform admin: an org admin, a signed-out caller and a stale sign-in are refused', async () => {
    const t = await applyKit(1);
    const trial = await trialOf(t);
    const body = {
      preset: 'trial',
      expectedRevision: trial.revision,
      values: { members: trial.members + 1 },
    };
    expect((await putPreset(t, body, t.kit.auth.user())).status).toBe(403);
    expect((await putPreset(t, body, {})).status).toBe(401);
    // An org is on the preset, so a change asks for a fresh sign-in.
    await orgOn(t, 'trial');
    t.kit.clock.advance(700_000);
    const stale = await putPreset(t, body);
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect((await trialOf(t)).members).toBe(trial.members);
  });

  it('refuses an unknown preset, a stale revision and a value the feature cannot take', async () => {
    const t = await applyKit(1);
    const { revision } = await trialOf(t);
    expect((await putPreset(t, { preset: 'nope', expectedRevision: 1, values: {} })).status).toBe(
      404,
    );
    expect(
      (await putPreset(t, { preset: 'trial', expectedRevision: revision + 5, values: {} })).status,
    ).toBe(409);
    expect(
      (await putPreset(t, { preset: 'trial', expectedRevision: revision, values: { apps: 7 } }))
        .status,
    ).toBe(422);
    expect(
      (await putPreset(t, { preset: 'trial', expectedRevision: revision, values: { nope: 1 } }))
        .status,
    ).toBe(422);
  });
});

describe('PUT /platform/entitlement-presets: an edit moves the orgs on the preset', () => {
  it('writes the values, one audit row, and moves each org once with its own audit and revision', async () => {
    const t = await applyKit(1);
    const a = await orgOn(t, 'trial');
    const b = await orgOn(t, 'trial');
    const before = await trialOf(t);
    const beforeA = await orgRow(t, a);
    const auditsBefore = (await orgAudit(t, a)).length;
    const res = await putPreset(t, {
      preset: 'trial',
      expectedRevision: before.revision,
      values: { members: before.members + 1, 'wallet.google': before.flipped },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as SetEntitlementPresetResult;
    expect(out).toMatchObject({
      moved: before.orgCount,
      preset: { revision: before.revision + 1, pendingOrgs: 0, orgCount: before.orgCount },
    });
    expect(out.preset.values.members).toBe(before.members + 1);
    expect(await orgRow(t, a)).toMatchObject({
      revision: (beforeA?.revision ?? 0) + 1,
      preset_revision: before.revision + 1,
    });
    expect((await orgRow(t, b))?.preset_revision).toBe(before.revision + 1);
    const rows = await orgAudit(t, a);
    expect(rows).toHaveLength(auditsBefore + 1);
    expect(JSON.parse(rows.at(-1)?.detail ?? '{}')).toMatchObject({
      via: 'preset',
      changes: {
        members: { from: before.members, to: before.members + 1 },
        'wallet.google': { from: before.google ? 1 : 0, to: before.flipped },
      },
    });
    const preset = await first<{ detail: string; org_id: string | null; actor_type: string }>(
      t.kit.env.DB,
      "SELECT detail, org_id, actor_type FROM audit_log WHERE action = 'entitlement_preset.update' ORDER BY id DESC",
    );
    expect(preset).toMatchObject({ org_id: null, actor_type: 'user' });
    expect(JSON.parse(preset?.detail ?? '{}')).toMatchObject({
      orgs: before.orgCount,
      version: before.revision + 1,
    });
    // The org's resolved values read the new preset.
    const org = (await (
      await t.kit.api(`/platform/orgs/${a}/entitlements`, { headers: t.kit.auth.admin() })
    ).json()) as OrgEntitlementsDto;
    expect(org.items.find((i) => i.key === 'members')?.value).toBe(before.members + 1);
  });

  it('queues the channel journal job of an org whose plan moves a channel, keyed on its new revision', async () => {
    const t = await applyKit(1);
    const org = await orgOn(t, 'trial');
    const before = await trialOf(t);
    const sent0 = jobs(t).length;
    const rev = (await orgRow(t, org))?.revision ?? 0;
    await putPreset(t, {
      preset: 'trial',
      expectedRevision: before.revision,
      values: { 'wallet.google': before.flipped },
    });
    const mine = jobs(t)
      .slice(sent0)
      .filter((j) => j.orgId === org);
    expect(mine).toHaveLength(1);
    expect(blocked(mine[0], 'blockedBefore')).toBe(!before.google);
    expect(blocked(mine[0], 'blockedAfter')).toBe(before.google);
    expect(mine[0]?.revision).toBe(rev + 1);
  });

  it('an edit that changes nothing writes nothing and moves nobody', async () => {
    const t = await applyKit(1);
    await orgOn(t, 'trial');
    const before = await trialOf(t);
    const sent = jobs(t).length;
    const res = await putPreset(t, {
      preset: 'trial',
      expectedRevision: before.revision,
      values: { members: before.members },
    });
    expect(((await res.json()) as SetEntitlementPresetResult).moved).toBe(0);
    expect((await trialOf(t)).revision).toBe(before.revision);
    expect(jobs(t)).toHaveLength(sent);
  });

  it('keeps an override over an edited key: the org keeps its value and is aligned', async () => {
    const t = await applyKit(1);
    const org = await orgOn(t, 'trial');
    const path = `/platform/orgs/${org}/entitlements`;
    const read = (await (
      await t.kit.api(path, { headers: t.kit.auth.admin() })
    ).json()) as OrgEntitlementsDto;
    await t.kit.api(path, {
      method: 'PUT',
      headers: { ...t.kit.auth.admin(), ...json },
      body: JSON.stringify({
        preset: 'trial',
        expectedRevision: read.revision,
        overrides: { members: { value: 99 } },
      }),
    });
    const before = await trialOf(t);
    await putPreset(t, {
      preset: 'trial',
      expectedRevision: before.revision,
      values: { members: before.members + 1 },
    });
    const now = (await (
      await t.kit.api(path, { headers: t.kit.auth.admin() })
    ).json()) as OrgEntitlementsDto;
    expect(now.items.find((i) => i.key === 'members')).toMatchObject({
      value: 99,
      presetValue: before.members + 1,
    });
    expect((await orgRow(t, org))?.preset_revision).toBe(before.revision + 1);
  });
});

describe('the move is bounded and idempotent', () => {
  it('moves at most the limit per call, refuses a new change meanwhile, and carries on once per org', async () => {
    const t = await applyKit(1);
    const orgs = [await orgOn(t, 'trial'), await orgOn(t, 'trial'), await orgOn(t, 'trial')];
    const before = await trialOf(t);
    const revisions = await Promise.all(orgs.map(async (o) => (await orgRow(t, o))?.revision ?? 0));
    const sent = jobs(t).length;
    const admin = await liveAdmin(t);
    const ctx = jobCtxOf(t.kit);
    const actor = { type: 'user', id: admin.userId } as const;
    // The limit is the number of organizations; one at a time shows the bound.
    const step = (input: Parameters<typeof setPreset>[3]) => setPreset(ctx, actor, admin, input, 1);
    const rev = before.revision;
    const edit = {
      preset: 'trial',
      expectedRevision: rev,
      values: { 'wallet.google': before.flipped },
    };

    expect(await step(edit)).toMatchObject({
      moved: 1,
      preset: { revision: rev + 1, pendingOrgs: before.orgCount - 1 },
    });
    // A different change while organizations wait is refused and writes nothing.
    await expect(
      step({ ...edit, expectedRevision: rev + 1, values: { members: before.members + 7 } }),
    ).rejects.toMatchObject({ code: 'PRESET_MOVING', status: 409 });
    expect((await trialOf(t)).revision).toBe(rev + 1);
    // The same call with no values carries on, one org a call; after the last it moves nobody.
    const resume = { preset: 'trial', expectedRevision: rev + 1, values: {} };
    let moved = 1;
    for (let i = 0; i < before.orgCount + 1; i++) moved += (await step(resume)).moved;
    expect(moved).toBe(before.orgCount);
    expect((await trialOf(t)).pendingOrgs).toBe(0);
    // The same edit again is a no-op: no org moves twice and no job repeats.
    expect(await step({ ...edit, expectedRevision: rev + 1 })).toMatchObject({ moved: 0 });
    for (const [i, o] of orgs.entries())
      expect(await orgRow(t, o)).toMatchObject({
        revision: (revisions[i] ?? 0) + 1,
        preset_revision: rev + 1,
      });
    const sentFor = jobs(t)
      .slice(sent)
      .map((j) => j.orgId);
    expect(new Set(sentFor).size).toBe(sentFor.length);
    for (const o of orgs) expect(sentFor).toContain(o);
  });

  it('a resumed move uses the plan as it was before the edit', async () => {
    const t = await applyKit(1);
    await orgOn(t, 'trial');
    await orgOn(t, 'trial');
    const before = await trialOf(t);
    const sent = jobs(t).length;
    const admin = await liveAdmin(t);
    const ctx = jobCtxOf(t.kit);
    const actor = { type: 'user', id: admin.userId } as const;
    const rev = before.revision;
    await setPreset(
      ctx,
      actor,
      admin,
      { preset: 'trial', expectedRevision: rev, values: { 'wallet.google': before.flipped } },
      1,
    );
    for (let i = 0; i < before.orgCount; i++)
      await setPreset(
        ctx,
        actor,
        admin,
        { preset: 'trial', expectedRevision: rev + 1, values: {} },
        1,
      );
    const sentNow = jobs(t).slice(sent);
    expect(sentNow).toHaveLength(before.orgCount);
    for (const j of sentNow) {
      expect(blocked(j, 'blockedBefore')).toBe(!before.google);
      expect(blocked(j, 'blockedAfter')).toBe(before.google);
    }
  });
});

describe('an expiring override is journaled like a save', () => {
  it('removes it, bumps the revision, audits as the system, and queues the channel run once', async () => {
    const t = await applyKit(2);
    const path = `/platform/orgs/${t.orgId}/entitlements`;
    const read = async () =>
      (await (await t.kit.api(path, { headers: t.kit.auth.admin() })).json()) as OrgEntitlementsDto;
    const before = await read();
    const expiresAt = t.kit.clock.now() + 3_600_000;
    const saved = await t.kit.api(path, {
      method: 'PUT',
      headers: { ...t.kit.auth.admin(), ...json },
      body: JSON.stringify({
        preset: before.preset,
        expectedRevision: before.revision,
        overrides: { 'wallet.google': { value: 0, expiresAt } },
      }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    // The save's own journal job opens the run: Google is blocked while the override stands.
    const [save] = jobs(t).slice(-1);
    expect(save?.blockedAfter).toContain('google');
    await handleEntitlementApply(save as JobOf<'channel.entitlement'>, jobCtxOf(t.kit));

    await expireEntitlementOverrides(jobCtxOf(t.kit));
    expect(jobs(t)).toHaveLength(1);
    expect((await orgRow(t, t.orgId))?.revision).toBe(before.revision + 1);

    t.kit.clock.set(expiresAt + 1000);
    await expireEntitlementOverrides(jobCtxOf(t.kit));
    const [expired] = jobs(t).slice(-1);
    expect(jobs(t)).toHaveLength(2);
    expect(expired).toMatchObject({
      orgId: t.orgId,
      revision: before.revision + 2,
      requestedBy: 'system',
    });
    expect(expired?.blockedBefore).toContain('google');
    expect(expired?.blockedAfter).not.toContain('google');
    expect(
      await first(t.kit.env.DB, 'SELECT 1 FROM org_entitlement_overrides WHERE org_id = ?', [
        t.orgId,
      ]),
    ).toBeNull();
    const audit = (await orgAudit(t, t.orgId)).at(-1);
    expect(audit?.actor_type).toBe('system');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      via: 'expiry',
      expired: ['wallet.google'],
    });

    // A repeat of the hook finds nothing: no second revision, no second job.
    await expireEntitlementOverrides(jobCtxOf(t.kit));
    expect(jobs(t)).toHaveLength(2);
    expect((await orgRow(t, t.orgId))?.revision).toBe(before.revision + 2);

    // The journal run now covers the expiry revision, and its plan ends with Google offered again.
    await handleEntitlementApply(expired as JobOf<'channel.entitlement'>, jobCtxOf(t.kit));
    const runs = (await t.runs()).filter((r) => r.from_blocked !== null);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ to_rev: before.revision + 2 });
  });
});
