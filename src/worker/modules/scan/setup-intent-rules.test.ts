import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanSetupResult } from '../../../shared/contracts/scan-setup-intent.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { door, fixture, made, newKey, post } from './setup-intent-test-fixtures.ts';

let templateId: string;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  templateId = await kit.scanTemplate('Rules pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
  app = createApp({
    stores: {
      ...fixture.fake.stores,
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const orgId = () => fixture.kit.org.id;
const intent = (name: string, over: Record<string, unknown> = {}) => ({
  orgId: orgId(),
  doors: [door(templateId, { name })],
  ...over,
});
const count = async (table: string) =>
  (
    await first<{ n: number }>(
      fixture.kit.env.DB,
      `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`,
      [orgId()],
    )
  )?.n;
const send = (headers: Record<string, string>, body: unknown, key: string | null = newKey()) =>
  app.request(
    'https://wallet.test/api/v1/scanning-sessions/setup',
    {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    },
    fixture.kit.env,
  );
/** A credential scope counts only on a key that expires within 91 days, so every key here does. */
const keyOf = (scopes: string[], over: { orgId?: string; mode?: 'live' | 'test' } = {}) =>
  makeApiKey(fixture.kit.fx, {
    orgId: orgId(),
    scopes,
    expiresAt: fixture.kit.fx.clock.now() + 30 * 86_400_000,
    ...over,
  });

describe('atomicity', () => {
  it('writes nothing when the last statement fails', async () => {
    const tables = [
      'scan_zones',
      'scan_events',
      'scan_staff',
      'scanning_sessions',
      'scanners',
      'audit_log',
    ];
    const before = await Promise.all(tables.map(count));
    const db = fixture.kit.env.DB;
    await run(
      db,
      `CREATE TRIGGER setup_boom BEFORE INSERT ON audit_log WHEN NEW.action = 'scan.setup.apply'
       BEGIN INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at)
         SELECT 'dup-a', NEW.org_id, 'dup', 'Dup A', 1, 1;
         INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at)
         SELECT 'dup-b', NEW.org_id, 'dup', 'Dup B', 1, 1; END`,
      [],
    );
    try {
      const res = await post(
        intent('Atomic door', {
          places: [{ ref: 'p', name: 'Atomic place', max: 3 }],
          staff: [{ name: 'Atomic Ann', role: 'door' }],
        }),
      );
      await expectProblem(res, 409, 'SCAN_SETUP_NAME_TAKEN');
    } finally {
      await run(db, 'DROP TRIGGER setup_boom', []);
    }
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });
});

describe('idempotency', () => {
  it('replays the same ids with no PINs or pairing codes, and refuses another body', async () => {
    const key = newKey();
    const body = intent('Replay door', { staff: [{ name: 'Replay Ray', role: 'desk' }] });
    const first1 = await made(await post(body, fixture.fake.admin(), key));
    expect(first1.staff[0]?.pin).toMatch(/^\d{6}$/);
    const scanners = await count('scanners');
    const again = await made(await post(body, fixture.fake.admin(), key));
    expect(again).toMatchObject({ replayed: true, pairingReissued: false });
    expect(again.sessions[0]?.id).toBe(first1.sessions[0]?.id);
    expect(again.staff[0]).toMatchObject({ id: first1.staff[0]?.id, pin: null });
    expect(again.sessions[0]?.devices.map((d) => d.id)).toEqual(
      first1.sessions[0]?.devices.map((d) => d.id),
    );
    expect(again.sessions[0]?.devices.every((d) => d.pairing === null)).toBe(true);
    expect(await count('scanners')).toBe(scanners);
    await expectProblem(
      await post(
        { ...body, doors: [door(templateId, { name: 'Other door' })] },
        fixture.fake.admin(),
        key,
      ),
      409,
      'SCAN_SETUP_KEY_REUSED',
    );
  });

  it('issues new pairing codes on a replay only when the old ones ran out', async () => {
    const key = newKey();
    const body = intent('Expiry door');
    const first1 = await made(await post(body, fixture.fake.admin(), key));
    fixture.kit.clock.advance(60 * 60_000);
    const again = await made(await post(body, fixture.fake.admin(), key));
    expect(again).toMatchObject({ replayed: true, pairingReissued: true });
    for (const d of again.sessions[0]?.devices ?? []) expect(d.pairing?.code).toHaveLength(10);
    expect(again.sessions[0]?.devices.map((d) => d.id)).toEqual(
      first1.sessions[0]?.devices.map((d) => d.id),
    );
  });

  it('requires the header to write, and not to plan', async () => {
    await expectProblem(
      await post(intent('No key'), fixture.fake.admin(), null),
      400,
      'SCAN_SETUP_KEY_REQUIRED',
    );
    expect((await post(intent('No key'), fixture.fake.admin(), null, '?dryRun=true')).status).toBe(
      200,
    );
  });
});

describe('who may call', () => {
  it('lets a scanning:write key set up its own org, with no user creator and the key in the audit', async () => {
    const k = await keyOf(['scanning:write']);
    const result = (await (await send(k.headers, intent('Key door'))).json()) as ScanSetupResult;
    expect(result.sessions[0]?.name).toBe('Key door');
    expect(result.sessions[0]?.devices.every((d) => d.pairing === null)).toBe(true);
    const session = await first<{ created_by: string | null }>(
      fixture.kit.env.DB,
      'SELECT created_by FROM scanning_sessions WHERE id = ?',
      [result.sessions[0]?.id ?? ''],
    );
    expect(session?.created_by).toBeNull();
    expect(
      await first(
        fixture.kit.env.DB,
        "SELECT actor_type AS t, actor_id AS a FROM audit_log WHERE action = 'scan.setup.apply' AND target_id = ?",
        [result.sessions[0]?.id ?? ''],
      ),
    ).toEqual({ t: 'api_key', a: k.id });
  });

  it('lets a write key make zones in live mode, but not staff or pairing codes', async () => {
    const k = await keyOf(['scanning:write']);
    const zoned = (await (
      await send(k.headers, intent('Key zone', { places: [{ ref: 'z', name: 'Key zone place' }] }))
    ).json()) as ScanSetupResult;
    expect(zoned.zones[0]?.created).toBe(true);
    const zone = await first<{ created_by: string | null }>(
      fixture.kit.env.DB,
      'SELECT created_by FROM scan_zones WHERE id = ?',
      [zoned.zones[0]?.id ?? ''],
    );
    expect(zone?.created_by).toBeNull();
    const before = await count('scanning_sessions');
    await expectProblem(
      await send(k.headers, intent('Key staff', { staff: [{ name: 'Key Kim', role: 'door' }] })),
      403,
      'SCAN_SETUP_ADMIN_SCOPE',
    );
    expect(await count('scanning_sessions')).toBe(before);
  });

  it('lets a scanning:write key alone apply an events-only setup', async () => {
    const k = await keyOf(['scanning:write']);
    const now = fixture.kit.clock.now();
    const res = await send(k.headers, {
      orgId: orgId(),
      events: [
        {
          ref: 'kv',
          name: 'Key event',
          templateIds: [templateId],
          opensAt: now,
          closesAt: now + 86_400_000,
        },
      ],
      doors: [{ name: 'Key event door', admits: { events: ['kv'] } }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as ScanSetupResult).events[0]?.created).toBe(true);
  });

  it('refuses zones to a test-mode key', async () => {
    const k = await keyOf(['scanning:write'], { mode: 'test' });
    await expectProblem(
      await send(
        k.headers,
        intent('Test zone', { places: [{ ref: 'z', name: 'Test zone place' }] }),
      ),
      403,
      'MODE_LIVE_REQUIRED',
    );
  });

  it('gives a scanning:admin key its PINs and pairing codes, once, and counts them in the audit', async () => {
    const k = await keyOf(['scanning:admin']);
    const result = (await (
      await send(
        k.headers,
        intent('Admin key door', { staff: [{ name: 'Admin Ada', role: 'desk' }] }),
      )
    ).json()) as ScanSetupResult;
    expect(result.staff[0]?.pin).toMatch(/^\d{6}$/);
    expect(result.sessions[0]?.devices.every((d) => d.pairing?.code.length === 10)).toBe(true);
    const audit = await first<{ detail: string; actor_type: string }>(
      fixture.kit.env.DB,
      "SELECT detail, actor_type FROM audit_log WHERE action = 'scan.setup.apply' AND target_id = ?",
      [result.sessions[0]?.id ?? ''],
    );
    expect(audit?.actor_type).toBe('api_key');
    // Every credential row the setup writes carries the caller's network prefix.
    const rows = await all<{ ip_prefix: string | null }>(
      fixture.kit.env.DB,
      "SELECT ip_prefix FROM audit_log WHERE actor_type = 'api_key' AND action IN ('scan_staff.create', 'scanner.pairing_create', 'scan.setup.apply') AND target_id IN (SELECT id FROM scan_staff UNION SELECT id FROM scanners UNION SELECT id FROM scanning_sessions)",
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.ip_prefix).toBe('203.0.113.0/24');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ pins: 1, pairingCodes: 1 });
  });

  it('rate limits a key that mints secrets', async () => {
    const k = await keyOf(['scanning:admin']);
    for (let n = 0; n < 10; n++)
      expect(
        (
          await send(
            k.headers,
            intent(`Burst ${n}`, { staff: [{ name: `Burst ${n}`, role: 'door' }] }),
          )
        ).status,
      ).toBe(200);
    await expectProblem(
      await send(k.headers, intent('Burst x', { staff: [{ name: 'Burst x', role: 'door' }] })),
      429,
      'RATE_LIMITED',
    );
  });

  it('turns away another org, a read-only key and a session without manage', async () => {
    const other = await makeOrg(fixture.kit.fx);
    const foreign = await makeApiKey(fixture.kit.fx, {
      orgId: other.id,
      scopes: ['scanning:write'],
    });
    expect((await send(foreign.headers, intent('Foreign'))).status).toBe(404);
    const own = await keyOf(['scanning:write']);
    expect((await send(own.headers, { ...intent('Elsewhere'), orgId: other.id })).status).toBe(404);
    const read = await keyOf(['scanning:read']);
    await expectProblem(await send(read.headers, intent('Read key')), 403, 'MISSING_SCOPE');
    expect((await post(intent('Plain user'), fixture.userHeaders)).status).toBe(403);
  });
});

describe('test mode and limits', () => {
  it('makes only test objects in test mode', async () => {
    const testTemplate = await fixture.kit.scanTemplate(
      'Test pass',
      { actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }] },
      { releaseModes: ['live', 'test'] },
    );
    const result = await made(
      await post(
        {
          orgId: orgId(),
          places: [{ ref: 'p', name: 'Test place', max: 4 }],
          doors: [door(testTemplate, { name: 'Test door', place: 'p' })],
        },
        fixture.fake.admin({ mode: 'test' }),
      ),
    );
    expect(result.mode).toBe('test');
    const modes = await all<{ mode: string }>(
      fixture.kit.env.DB,
      `SELECT mode FROM scanning_sessions WHERE id = ?
       UNION ALL SELECT mode FROM scanners WHERE id IN (SELECT scanner_id FROM scanning_devices WHERE session_id = ?)`,
      [result.sessions[0]?.id ?? '', result.sessions[0]?.id ?? ''],
    );
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.every((m) => m.mode === 'test')).toBe(true);
    expect(result.checks.some((c) => c.code === 'TEST_ONLY')).toBe(true);
  });

  it('refuses a request over the limits with the field path, writing nothing', async () => {
    const before = await count('scan_zones');
    const nine = Array.from({ length: 9 }, (_, i) => ({ ref: `z${i}`, name: `Limit ${i}` }));
    const res = await post(intent('Limits', { places: nine }));
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { issues: { path: string }[] };
    expect(problem.issues.map((i) => i.path)).toContain('places');
    const tooMany = await post(
      intent('Limits', {
        events: [
          {
            ref: 'e',
            name: 'Big',
            templateIds: Array.from({ length: 21 }, (_, i) => `t${i}`),
            opensAt: 1,
            closesAt: 2,
          },
        ],
      }),
    );
    expect(tooMany.status).toBe(422);
    expect(((await tooMany.json()) as { issues: { path: string }[] }).issues[0]?.path).toMatch(
      /^events\.0/,
    );
    expect(await count('scan_zones')).toBe(before);
  });
});
