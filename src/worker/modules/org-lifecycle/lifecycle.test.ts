import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { runOrgExport } from '../../workflows/org-export.ts';
import { serialsSince } from '../apple/repo.ts';
import { toDto } from '../operations/dto.ts';
import { rowById } from '../operations/repo.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { requestExport } from './export-start.ts';
import { dailyOrgLifecycle } from './jobs.ts';
import { fakeStep, populateOrg } from './lifecycle-test-fixtures.ts';
import { operationRunners } from './operations.ts';
import { exportRow } from './repo.ts';
import {
  closeOrg,
  exportLink,
  listExports,
  openExport,
  readLifecycle,
  reopenOrg,
} from './service.ts';

const DAY = 86_400_000;
const actor = { type: 'system' as const, id: null };
const fake = fakeAuth();
let rk: RetentionKit;
let kit: RetentionKit['kit'];
let app: ReturnType<typeof createApp>;
const started: { id: string; params: { orgId: string; exportId: string } }[] = [];
beforeAll(async () => {
  rk = await retentionKit();
  kit = rk.kit;
  (kit.env as { ORG_EXPORT: unknown }).ORG_EXPORT = {
    async create(o: (typeof started)[number]) {
      started.push(o);
      return { id: o.id };
    },
  };
  // The daily sweep starts a purge per due org; a real instance would outlive the test.
  (kit.env as { ORG_PURGE: unknown }).ORG_PURGE = {
    async create(o: { id: string }) {
      return { id: o.id };
    },
  };
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({ stores: fake.stores, clock: kit.clock });
}, 30_000);

const platform = async () => ({ kind: 'platform' as const, ...(await rk.platform()) });
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const orgRow = (orgId: string) =>
  first<Record<string, unknown>>(
    kit.env.DB,
    'SELECT status, closed_at, purge_after, default_identity_id FROM orgs WHERE id = ?',
    [orgId],
  );
const runExport = async (orgId: string, exportId: string) =>
  runOrgExport(kit.env, { orgId, exportId }, fakeStep(), undefined, kit.clock);
const operationOf = async (id: string | null) =>
  toDto((await rowById(kit.env.DB, id ?? '')) as never);

describe('close and reopen', () => {
  it('close stops passes updating and opens a 30-day window; reopen restores them and the identity', async () => {
    const org = await populateOrg(rk, 'close');
    const pass = await kit.pass({ orgId: org.orgId });
    await kit.device(pass, 'dev-close', 'push');
    await run(kit.env.DB, 'UPDATE orgs SET default_identity_id = ? WHERE id = ?', [
      'identity-close',
      org.orgId,
    ]);
    const serials = () => serialsSince(kit.env.DB, 'dev-close', pass.identityId, 0, 10);
    expect(await serials()).toHaveLength(1);

    const closedAt = kit.clock.now();
    const out = await closeOrg(kit.ctx, actor, org.orgId, await platform());
    expect(out).toMatchObject({
      status: 'closed',
      purgeAfter: closedAt + 30 * DAY,
      canReopen: true,
    });
    expect(await orgRow(org.orgId)).toMatchObject({ status: 'deleted', default_identity_id: null });
    expect(await serials()).toEqual([]);
    expect(rk.mail.some((m) => m.subject.includes('is closed'))).toBe(true);

    expect(await reopenOrg(kit.ctx, actor, org.orgId, await platform())).toMatchObject({
      status: 'active',
      closedAt: null,
      purgeAfter: null,
    });
    expect(await orgRow(org.orgId)).toMatchObject({
      status: 'active',
      default_identity_id: 'identity-close',
    });
    expect(await serials()).toHaveLength(1);
  });

  it('a legal hold refuses a close; the window ends a reopen', async () => {
    const held = await populateOrg(rk, 'hold-close');
    await run(
      kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, 'platform', 'p', 'r', 1)",
      [kit.fx.ids.id(), held.orgId],
    );
    await expect(closeOrg(kit.ctx, actor, held.orgId, await platform())).rejects.toMatchObject({
      code: 'ORG_HELD',
    });
    const org = await populateOrg(rk, 'window');
    await closeOrg(kit.ctx, actor, org.orgId, await platform());
    kit.clock.advance(30 * DAY + 1);
    await expect(reopenOrg(kit.ctx, actor, org.orgId, await platform())).rejects.toMatchObject({
      code: 'ORG_REOPEN_WINDOW',
    });
  });

  it('an org admin closes her own org only with its slug', async () => {
    const org = await populateOrg(rk, 'owner');
    const row = await first<{ slug: string }>(kit.env.DB, 'SELECT slug FROM orgs WHERE id = ?', [
      org.orgId,
    ]);
    const headers = fake.user(org.adminUserId);
    const url = `/api/v1/orgs/${org.orgId}/close`;
    expect((await call('POST', url, headers, { confirmSlug: 'nope' })).status).toBe(422);
    const done = await call('POST', url, headers, { confirmSlug: row?.slug });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'closed' });
    const root = fake.session({ userId: (await rk.platform()).userId, roles: ['admin', 'user'] });
    const listed = (await (await call('GET', '/api/v1/platform/closed-orgs', root)).json()) as {
      items: { id: string }[];
    };
    expect(listed.items.map((o) => o.id)).toContain(org.orgId);
    expect((await call('GET', '/api/v1/platform/closed-orgs', headers)).status).toBe(403);
    // Reopening is the platform's; the admin has no way back.
    expect((await call('POST', `/api/v1/orgs/${org.orgId}/reopen`, headers)).status).toBe(403);
    expect((await call('POST', `/api/v1/orgs/${org.orgId}/reopen`, root)).status).toBe(200);
  });
});

describe('export', () => {
  it('archives exactly the org: its rows, no secrets, nothing of another org', async () => {
    const a = await populateOrg(rk, 'exp-a');
    const b = await populateOrg(rk, 'exp-b');
    await run(
      kit.env.DB,
      "UPDATE users SET primary_email = 'private-' || id || '@elsewhere.test' WHERE id IN (SELECT user_id FROM org_memberships WHERE org_id = ?)",
      [a.orgId],
    );
    const row = await requestExport(kit.ctx, actor, a.orgId, await platform());
    expect(row.state).toBe('queued');
    expect(started.at(-1)?.params).toEqual({
      orgId: a.orgId,
      exportId: row.id,
      operationId: row.operationId,
      attempt: 1,
    });
    await expect(requestExport(kit.ctx, actor, a.orgId, await platform())).rejects.toMatchObject({
      code: 'ORG_EXPORT_RUNNING',
    });
    expect(await runExport(a.orgId, row.id)).toEqual({ state: 'ready' });
    expect(await runExport(a.orgId, row.id)).toEqual({ state: 'skipped' });

    const done = await first<{ r2_key: string; bytes: number; entities: string; state: string }>(
      kit.env.DB,
      'SELECT r2_key, bytes, entities, state FROM org_exports WHERE id = ?',
      [row.id],
    );
    expect(done?.state).toBe('ready');
    const zip = await kit.env.BUCKET.get(done?.r2_key ?? '');
    const files = unzipSync(new Uint8Array((await zip?.arrayBuffer()) ?? new ArrayBuffer(0)));
    const text = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
    const rows = (name: string) =>
      (text[`${name}.ndjson`] ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      rows('passes')
        .map((p) => p.id)
        .sort(),
    ).toEqual([...a.passes].sort());
    expect(rows('passes').find((p) => p.holder_email)?.holder_email).toBe(a.holderEmail);
    expect(rows('org').map((o) => o.id)).toEqual([a.orgId]);
    expect(rows('pass_notes').map((n) => n.body)).toEqual(['note-exp-a']);
    const members = (orgId: string) =>
      all<{ user_id: string }>(kit.env.DB, 'SELECT user_id FROM org_memberships WHERE org_id = ?', [
        orgId,
      ]);
    expect(
      rows('members')
        .map((m) => m.user_id)
        .sort(),
    ).toEqual((await members(a.orgId)).map((m) => m.user_id).sort());
    const primaries = await all<{ primary_email: string }>(
      kit.env.DB,
      'SELECT u.primary_email FROM users u JOIN org_memberships m ON m.user_id = u.id WHERE m.org_id = ?',
      [a.orgId],
    );
    expect(primaries.length).toBeGreaterThan(0);
    for (const u of primaries) expect(text['members.ndjson']).not.toContain(u.primary_email);
    expect(text['members.ndjson']).not.toContain('@elsewhere.test');
    expect(rows('templates').map((t) => t.id)).toEqual([a.templateId]);
    expect(
      Object.keys(text).some((k) => k.startsWith('template-files/') && k.endsWith('icon.png')),
    ).toBe(true);
    const counts = JSON.parse(done?.entities ?? '{}') as Record<string, number>;
    expect(counts.passes).toBe(3);
    // The wave's tables: roll calls, tag metadata (a hint, never the tag or a key).
    expect(rows('roll_calls')).toHaveLength(1);
    expect(rows('roll_call_marks')).toHaveLength(1);
    expect(rows('scan_group_members')).toHaveLength(1);
    expect(rows('nfc_tags').map((t) => t.hint)).toEqual(['AB12', 'CD34']);
    expect(rows('nfc_tag_keysets')).toHaveLength(1);
    expect(rows('org_entitlement_overrides')).toHaveLength(1);
    expect(rows('scanning_sessions').map((s) => s.setup_template_id)).toEqual(['tpl-exp-a']);
    expect(counts.nfc_tags).toBe(2);
    expect(Object.keys(text).some((k) => /nfc_tag_(keys|sun)\.|idempotent|offline/.test(k))).toBe(
      false,
    );
    expect(text['nfc_tags.ndjson']).not.toContain('tag_ref');

    const everything = Object.values(text).join('\n');
    for (const leaked of [
      b.orgId,
      ...b.passes,
      b.holderEmail,
      b.templateId,
      ...(await members(b.orgId)).map((m) => m.user_id),
    ])
      expect(everything).not.toContain(leaked);
    for (const secret of [
      'auth_token',
      'download_token',
      'token_hash',
      'pin_hash',
      'csrf_secret',
      'key_hash',
    ])
      expect(everything).not.toContain(secret);
    // Staged parts are gone; only the archive is left.
    const left = await kit.env.BUCKET.list({ prefix: `exports/${a.orgId}/` });
    expect(left.objects.map((o) => o.key)).toEqual([done?.r2_key]);
  });

  it('shows the export as an operation: counted rows, then Done', async () => {
    const org = await populateOrg(rk, 'op-ok');
    const row = await requestExport(kit.ctx, actor, org.orgId, await platform(), 'test');
    expect(await operationOf(row.operationId)).toMatchObject({
      kind: 'org.export',
      orgId: org.orgId,
      mode: 'test',
      target: { type: 'export', id: row.id },
      status: 'queued',
    });
    const params = started.at(-1)?.params as Parameters<typeof runOrgExport>[1];
    await runOrgExport(kit.env, params, fakeStep(), undefined, kit.clock);
    const op = await operationOf(row.operationId);
    expect(op).toMatchObject({
      status: 'succeeded',
      result: { href: null, ids: { exportId: row.id } },
    });
    expect(op.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(op.steps[0]?.total).toBeGreaterThan(0);
    expect(op.steps[0]?.done).toBe(op.steps[0]?.total);
    expect(JSON.stringify(op)).not.toMatch(/@/);
  });

  it('a failed export fails its operation and Retry starts it over under a new instance', async () => {
    const org = await populateOrg(rk, 'op-fail');
    const row = await requestExport(kit.ctx, actor, org.orgId, await platform());
    const params = started.at(-1)?.params as Parameters<typeof runOrgExport>[1];
    const step = fakeStep();
    const inner = step.do.bind(step) as (name: string, ...a: unknown[]) => Promise<unknown>;
    (step as { do: unknown }).do = async (name: string, ...rest: unknown[]) => {
      if (name === 'zip') throw new Error('crash');
      return inner(name, ...rest);
    };
    await runOrgExport(kit.env, params, step, undefined, kit.clock);
    const failed = await operationOf(row.operationId);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'ORG_EXPORT_FAILED', retryable: true },
    });
    const relaunch = operationRunners['org.export']?.relaunch;
    const launched = await relaunch?.(kit.ctx, failed, { instanceId: row.id }, {
      kind: 'system',
    } as never);
    expect(launched).toEqual({ workflowInstanceId: `${row.id}-r1` });
    expect(started.at(-1)?.id).toBe(`${row.id}-r1`);
    expect((await exportRow(kit.env.DB, org.orgId, row.id))?.state).toBe('queued');
  });

  it('an export whose org is purged stops writing and fails', async () => {
    const org = await populateOrg(rk, 'gone');
    const row = await requestExport(kit.ctx, actor, org.orgId, await platform());
    await run(kit.env.DB, 'DELETE FROM org_exports WHERE id = ?', [row.id]);
    expect(await runExport(org.orgId, row.id)).toEqual({ state: 'skipped' });
    await run(
      kit.env.DB,
      "INSERT INTO org_exports (id, org_id, state, created_at) VALUES (?, ?, 'queued', 1)",
      [row.id, org.orgId],
    );
    let n = 0;
    const step = fakeStep();
    const inner = step.do.bind(step) as (name: string, ...a: unknown[]) => Promise<unknown>;
    (step as { do: unknown }).do = async (name: string, ...rest: unknown[]) => {
      if (++n === 3) await run(kit.env.DB, 'DELETE FROM org_exports WHERE id = ?', [row.id]);
      return inner(name, ...rest);
    };
    expect(
      await runOrgExport(
        kit.env,
        { orgId: org.orgId, exportId: row.id },
        step,
        undefined,
        kit.clock,
      ),
    ).toEqual({ state: 'failed' });
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM org_exports WHERE id = ?', [row.id]),
    ).toBeNull();
  });

  it('a link opens the archive once, for that export only', async () => {
    const org = await populateOrg(rk, 'link');
    const row = await requestExport(kit.ctx, actor, org.orgId, await platform());
    await expect(
      exportLink(kit.ctx, actor, org.orgId, row.id, await platform()),
    ).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    await runExport(org.orgId, row.id);
    const { url, expiresAt } = await exportLink(
      kit.ctx,
      actor,
      org.orgId,
      row.id,
      await platform(),
    );
    const query = new URL(url).searchParams;
    const open = (exp: number, sig: string, id = row.id) => openExport(kit.ctx, id, exp, sig);
    const file = await open(expiresAt, query.get('sig') ?? '');
    expect(file.name).toMatch(/-export-\d{4}-\d{2}-\d{2}\.zip$/);
    await expect(open(expiresAt, '0'.repeat(64))).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    await expect(open(expiresAt + 1, query.get('sig') ?? '')).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    await expect(open(expiresAt, query.get('sig') ?? '', 'other')).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    await expect(open(expiresAt, query.get('sig') ?? '')).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
  });

  it("a personal organization's export is its owner's, not another platform admin's", async () => {
    const org = await populateOrg(rk, 'personal-exp');
    // The marker is fixed at insert by a trigger; lift it for the fixture and put it back.
    await run(kit.env.DB, 'DROP TRIGGER orgs_personal_fixed');
    await run(kit.env.DB, 'UPDATE orgs SET personal_user_id = ? WHERE id = ?', [
      org.adminUserId,
      org.orgId,
    ]);
    await run(
      kit.env.DB,
      `CREATE TRIGGER orgs_personal_fixed BEFORE UPDATE OF personal_user_id ON orgs
       WHEN NEW.personal_user_id IS NOT OLD.personal_user_id
       BEGIN SELECT RAISE(ABORT, 'orgs personal marker is immutable'); END`,
    );
    const admin = await platform();
    await expect(requestExport(kit.ctx, actor, org.orgId, admin)).rejects.toMatchObject({
      code: 'ORG_NOT_FOUND',
    });
    await expect(listExports(kit.ctx, org.orgId, admin)).rejects.toMatchObject({
      code: 'ORG_NOT_FOUND',
    });
    const owner = { kind: 'owner' as const, userId: org.adminUserId, sessionId: 'unused' };
    await expect(requestExport(kit.ctx, actor, org.orgId, owner)).rejects.not.toMatchObject({
      code: 'ORG_NOT_FOUND',
    });
    await expect(exportLink(kit.ctx, actor, org.orgId, 'x', admin)).rejects.toMatchObject({
      code: 'ORG_NOT_FOUND',
    });
    expect((await readLifecycle(kit.ctx, org.orgId, admin)).status).toBe('active');
  });

  it('a link lasts an hour and one download; a newer link replaces it', async () => {
    const org = await populateOrg(rk, 'link-once');
    const row = await requestExport(kit.ctx, actor, org.orgId, await platform());
    await runExport(org.orgId, row.id);
    const mint = async () => {
      const { url, expiresAt } = await exportLink(
        kit.ctx,
        actor,
        org.orgId,
        row.id,
        await platform(),
      );
      return { exp: expiresAt, sig: new URL(url).searchParams.get('sig') ?? '' };
    };
    const first_ = await mint();
    expect(first_.exp - kit.clock.now()).toBe(60 * 60_000);
    await openExport(kit.ctx, row.id, first_.exp, first_.sig);
    await expect(openExport(kit.ctx, row.id, first_.exp, first_.sig)).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    kit.clock.advance(1000);
    const older = await mint();
    kit.clock.advance(1000);
    const newer = await mint();
    await expect(openExport(kit.ctx, row.id, older.exp, older.sig)).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
    await openExport(kit.ctx, row.id, newer.exp, newer.sig);
    const late = await mint();
    kit.clock.advance(60 * 60_000 + 1);
    await expect(openExport(kit.ctx, row.id, late.exp, late.sig)).rejects.toMatchObject({
      code: 'EXPORT_NOT_FOUND',
    });
  });

  it('a closed org still exports for its admin and for PassBook, not for others, and the sweep expires the archive', async () => {
    const org = await populateOrg(rk, 'closed-export');
    await closeOrg(kit.ctx, actor, org.orgId, await platform());
    const owner = fake.user(org.adminUserId);
    const other = fake.user((await populateOrg(rk, 'stranger')).adminUserId);
    const url = `/api/v1/orgs/${org.orgId}/exports`;
    expect((await call('POST', url, other)).status).toBe(403);
    expect((await call('GET', url, other)).status).toBe(403);
    const made = await call('POST', url, owner);
    expect(made.status).toBe(202);
    const { id } = (await made.json()) as { id: string };
    await runExport(org.orgId, id);
    const link = await call('POST', `${url}/${id}/link`, owner);
    expect(link.status).toBe(200);
    const { url: download } = (await link.json()) as { url: string };
    const file = await app.request(
      new URL(download).pathname + new URL(download).search,
      {},
      kit.env,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/zip');
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(unzipSync(new Uint8Array(await file.arrayBuffer()))).length).toBeGreaterThan(
      10,
    );

    kit.clock.advance(8 * DAY);
    await dailyOrgLifecycle(kit.ctx);
    const after = await first<{ state: string; r2_key: string | null }>(
      kit.env.DB,
      'SELECT state, r2_key FROM org_exports WHERE id = ?',
      [id],
    );
    expect(after).toEqual({ state: 'expired', r2_key: null });
    expect((await kit.env.BUCKET.list({ prefix: `exports/${org.orgId}/` })).objects).toHaveLength(
      0,
    );
  });
});
