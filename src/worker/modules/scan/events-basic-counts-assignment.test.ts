import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeTemplate,
  makeUser,
  persistTemplate,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, makeLegacyScanPass } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;
let templateId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(env.DB, clock);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  await run(env.DB, 'DELETE FROM audit_log');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  await grantScanMembership(f, orgId, userId);
  templateId = await template(orgId);
});

async function persistApprovedTemplate(t: TestTemplate, org: string): Promise<void> {
  await persistTemplate(f, t.resolved, { registry: t.registry });
  const fixture = { ctx: createServiceContext(env, { clock }), fx: f, registry: t.registry };
  for (const mode of ['live', 'test'] as const) {
    await approveAppleRelease(fixture, {
      orgId: org,
      templateId: t.resolved.id,
      version: t.resolved.version,
      mode,
    });
  }
}

async function template(org: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const t = makeTemplate({ id: f.ids.id(), orgId: org });
  Object.assign(t.resolved.manifest, manifest);
  await persistApprovedTemplate(t, org);
  return t.resolved.id;
}
const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const call = (method: string, path: string, body?: unknown, headers = admin()) =>
  app.request(
    `${ORIGIN}/api/v1/scan-events${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
interface Ev {
  id: string;
  status: string;
  arrived: number;
  expected: number;
  scanners: number;
  note: string | null;
  templateIds: string[];
  match: { input: string; values: string[] } | null;
  code?: string;
}
async function create(over: Record<string, unknown> = {}, headers = admin()) {
  clock.advance(1);
  const res = await call(
    'POST',
    '',
    {
      orgId,
      name: `Event ${f.ids.token(3)}`,
      templateIds: [templateId],
      opensAt: clock.now() - HOUR,
      closesAt: clock.now() + HOUR,
      timeZone: 'Europe/Berlin',
      ...over,
    },
    headers,
  );
  return { res, body: (await res.clone().json()) as Ev };
}
const auditActions = async () => {
  const rows = await all<{ action: string }>(
    env.DB,
    "SELECT action FROM audit_log WHERE action LIKE 'scan_event.%' ORDER BY id",
  );
  return rows.map((r) => r.action);
};

describe('events', () => {
  it('the staff note: over 140 characters or with a control character is a 422; clearing stores NULL', async () => {
    expect((await create({ note: 'x'.repeat(141) })).res.status).toBe(422);
    expect((await create({ note: 'line\nbreak' })).res.status).toBe(422);
    const { body } = await create({ note: 'VIP list at the desk.' });
    expect(body.note).toBe('VIP list at the desk.');
    const cleared = await call('PATCH', `/${body.id}`, { note: null });
    expect(((await cleared.json()) as Ev).note).toBeNull();
    expect(
      (
        await first<{ note: string | null }>(env.DB, 'SELECT note FROM scan_events WHERE id = ?', [
          body.id,
        ])
      )?.note,
    ).toBeNull();
  });

  it('recounts expected passes immediately while respecting the match rule', async () => {
    const made = makeTemplate({ id: f.ids.id(), orgId });
    Object.assign(made.resolved.manifest, {
      inputs: {
        type: 'object',
        required: ['memberName'],
        properties: { memberName: { type: 'string' }, tier: { type: 'string' } },
      },
    });
    await persistApprovedTemplate(made, orgId);
    const t = made.resolved.id;
    const seed = async (tier: string, over: { status?: string; mode?: 'live' | 'test' } = {}) => {
      const pass = await makeLegacyScanPass(f, {
        orgId,
        template: made.resolved,
        mode: over.mode ?? 'live',
        personalization: { memberName: 'M', tier },
      });
      if (over.status)
        await run(env.DB, 'UPDATE passes SET status = ? WHERE id = ?', [over.status, pass.id]);
    };
    await seed('gold');
    await seed('gold');
    await seed('silver');
    await seed('gold', { status: 'voided' });
    await seed('gold', { mode: 'test' });
    const all1 = await create({ templateIds: [t] });
    expect(all1.body.expected).toBe(3);
    const gold = await create({
      templateIds: [t],
      match: { input: 'tier', values: ['gold', 'bronze'] },
    });
    expect(gold.body.expected).toBe(2);
    await run(env.DB, 'UPDATE scan_events SET expected = ?, expected_at = ? WHERE id = ?', [
      2,
      clock.now(),
      gold.body.id,
    ]);
    await seed('gold');
    expect(((await (await call('GET', `/${gold.body.id}`)).json()) as Ev).expected).toBe(3);
    clock.advance(61_000);
    expect(((await (await call('GET', `/${gold.body.id}`)).json()) as Ev).expected).toBe(3);
    expect(
      await first<{ expected: number | null; expected_at: number | null }>(
        env.DB,
        'SELECT expected, expected_at FROM scan_events WHERE id = ?',
        [gold.body.id],
      ),
    ).toEqual({ expected: 3, expected_at: clock.now() });
  });

  it('does not count event gates without a witnessed admission', async () => {
    const made = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(made, orgId);
    const { body } = await create({ templateIds: [made.resolved.id] });
    const gate = async (state: string) => {
      const pass = await makeLegacyScanPass(f, { orgId, template: made.resolved });
      await run(
        env.DB,
        `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, 'check_in', ?, ?, 'live', ?, 'check_in', ?, 1, 1, 1, 's')`,
        [pass.id, `event:${body.id}`, orgId, made.resolved.id, state],
      );
    };
    await gate('in');
    await gate('undone');
    await gate('out');
    expect(((await (await call('GET', `/${body.id}`)).json()) as Ev).arrived).toBe(0);
  });
});

describe('assign and archive', () => {
  it('assigning moves a scanner off its old event', async () => {
    const e1 = (await create()).body;
    const e2 = (await create()).body;
    const s = await makeScanner(f, { orgId, eventId: e1.id });
    const res = await call('POST', `/${e2.id}/scanners`, { scannerIds: [s.id] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Ev).scanners).toBe(1);
    expect(((await (await call('GET', `/${e1.id}`)).json()) as Ev).scanners).toBe(0);
    expect(
      (
        await first<{ event_id: string }>(env.DB, 'SELECT event_id FROM scanners WHERE id = ?', [
          s.id,
        ])
      )?.event_id,
    ).toBe(e2.id);
    expect(await auditActions()).toContain('scan_event.assign');
  });

  it("another org's scanner is a 404, another mode's a 422 SCAN_MODE_MISMATCH", async () => {
    const e = (await create()).body;
    const other = await makeOrg(f);
    const theirs = await makeScanner(f, { orgId: other.id });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [theirs.id] })).status).toBe(404);
    const testScanner = await makeScanner(f, { orgId, mode: 'test' });
    const res = await call('POST', `/${e.id}/scanners`, { scannerIds: [testScanner.id] });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_MODE_MISMATCH');
    const screen = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [screen.id] })).status).toBe(422);
  });

  it('archiving detaches every scanner, leaves the session unassigned and bumps configRev', async () => {
    const e = (await create()).body;
    const s = await makeScanner(f, { orgId, eventId: e.id });
    const before =
      (
        await first<{ updated_at: number }>(
          env.DB,
          'SELECT updated_at FROM scanners WHERE id = ?',
          [s.id],
        )
      )?.updated_at ?? 0;
    clock.advance(7_000);
    const res = await call('POST', `/${e.id}/archive`);
    expect(((await res.json()) as Ev).status).toBe('archived');
    const row = await first<{ event_id: string | null; updated_at: number }>(
      env.DB,
      'SELECT event_id, updated_at FROM scanners WHERE id = ?',
      [s.id],
    );
    expect(row).toEqual({ event_id: null, updated_at: before + 7_000 });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [s.id] })).status).toBe(422);
    expect((await call('POST', `/${e.id}/archive`)).status).toBe(200);
    expect((await auditActions()).filter((a) => a === 'scan_event.archive')).toHaveLength(1);
    const again = await call('PATCH', `/${e.id}`, { archived: false });
    expect(((await again.json()) as Ev).status).toBe('live');
  });

  it('an event is a 404 for the wrong id and requires an organization selection', async () => {
    expect((await call('GET', '/missing')).status).toBe(404);
    expect((await call('GET', '', undefined, fake.user())).status).toBe(403);
    await makeScanEvent(f, { orgId });
  });
});
