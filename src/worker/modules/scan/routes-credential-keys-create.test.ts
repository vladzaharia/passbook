import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { credentialKeysFixture, FORMAT } from './credential-keys-test-fixtures.ts';

const t = credentialKeysFixture();
type Keys = Awaited<ReturnType<typeof t.keys>>;
let keys: Keys;
let template = '';
beforeAll(async () => {
  await t.setup();
  keys = await t.keys();
  const made = await t.scanner('terminal');
  const row = await first<{ id: string }>(
    t.env().DB,
    'SELECT template_id AS id FROM scanner_templates WHERE scanner_id = ?',
    [made.id],
  );
  template = row?.id ?? '';
});

let n = 0;
const scannerBody = (kind: 'device' | 'terminal' = 'device', orgId = t.orgId()) => ({
  orgId,
  name: `Key ${kind} ${++n}`,
  kind,
  accepts: { templateIds: [template] },
  timeZone: 'UTC',
});
const create = (headers: Record<string, string>, body = scannerBody(), idem?: string) =>
  t.send('POST', '/scanners', headers, body, idem);
const redeem = (code: string) =>
  t.fixture.call('POST', '/scan/pair', { code }, { origin: 'https://wallet.test' });
const count = async (table: string) =>
  (await first<{ n: number }>(t.env().DB, `SELECT count(*) AS n FROM ${table}`))?.n ?? 0;

describe('create a scanner by key', () => {
  it('gives an admin key a device and its code, once, in one batch', async () => {
    const body = scannerBody();
    const first1 = await create(keys.admin.headers, body, 'make-once');
    const replay = await create(keys.admin.headers, body, 'make-once');
    const shown = ((await first1.clone().json()) as { pairing: { code: string } }).pairing.code;
    await t.expectOnce({
      first: first1,
      replay,
      secrets: { 'pairing.code': FORMAT.code, 'pairing.url': FORMAT.url },
      ids: ['id'],
      keyId: keys.admin.id,
      action: 'scanner.pairing_create',
      target: (one) => String(one.id),
      reads: [],
    });
    const id = ((await first1.json()) as { id: string }).id;
    expect(await t.keyAudit(id, 'scanner.create')).toHaveLength(1);
    expect(
      await first(t.env().DB, 'SELECT created_by, pair_created_by FROM scanners WHERE id = ?', [
        id,
      ]),
    ).toEqual({ created_by: null, pair_created_by: null });
    expect(
      await first(t.env().DB, 'SELECT created_by FROM scanning_sessions WHERE id = ?', [id]),
    ).toEqual({ created_by: null });
    expect((await redeem(shown)).status).toBe(200);
    await t.expectIdempotencyScope({
      other: (await t.keys()).admin.headers,
      run: (h, variant) =>
        create(
          h,
          variant ? { ...body, timeZone: 'Europe/Paris' } : { ...body, name: 'Other key door' },
          'make-once',
        ),
      secret: 'pairing.code',
      firstSecret: shown,
    });
  });

  it('gives a terminal no code, and a write key none either, in either mode', async () => {
    const till = await create(keys.admin.headers, scannerBody('terminal'));
    expect(till.status).toBe(201);
    expect(((await till.json()) as { pairing: unknown }).pairing).toBeNull();
    for (const mode of ['live', 'test'] as const) {
      const w = await t.key(['scanning:write'], { mode });
      const res = await create(w.headers);
      expect(res.status, mode).toBe(201);
      const made = (await res.json()) as { id: string; pairing: unknown; mode: string };
      expect(made.pairing).toBeNull();
      expect(made.mode).toBe(mode);
      expect(await t.keyAudit(made.id, 'scanner.pairing_create')).toHaveLength(0);
      expect(
        await first(t.env().DB, 'SELECT pair_code_hash FROM scanners WHERE id = ?', [made.id]),
      ).toEqual({ pair_code_hash: null });
      expect((await t.keyAudit(made.id, 'scanner.create'))[0]?.ip_prefix).toBe('203.0.113.0/24');
    }
  });

  it('refuses a taken name with 409 and writes nothing, costing no budget', async () => {
    const k = await t.key(['scanning:admin']);
    const body = scannerBody();
    expect((await create(k.headers, body)).status).toBe(201);
    const [scanners, audits] = [await count('scanners'), await t.auditCount()];
    for (let i = 0; i < 3; i++)
      await expectProblem(await create(k.headers, body), 409, 'SCANNER_NAME_TAKEN');
    expect([await count('scanners'), await t.auditCount()]).toEqual([scanners, audits]);
    const day = Math.floor(t.fixture.kit.clock.now() / 86_400_000) * 86_400_000;
    const used = await first<{ count: number }>(
      t.env().DB,
      'SELECT count FROM counters WHERE key = ? AND window_start = ?',
      [`scan-setup:secrets:${k.id}`, day],
    );
    expect(used?.count).toBe(1);
  });

  it('refuses a key that may not, and writes nothing', async () => {
    const before = [await count('scanners'), await t.auditCount()];
    await expectProblem(await create(keys.read.headers), 403, 'MISSING_SCOPE');
    await expectProblem(await create(keys.platform.headers), 404, 'ORG_NOT_FOUND');
    await expectProblem(await create(keys.otherOrg.headers), 404, 'ORG_NOT_FOUND');
    await expectProblem(
      await create(keys.admin.headers, scannerBody('device', keys.otherOrgId)),
      404,
      'ORG_NOT_FOUND',
    );
    await expectProblem(await create(keys.restricted.headers), 403, 'API_KEY_RESTRICTED_ROUTE');
    // A test-mode admin key (forced past the mint rule) cannot make a credential.
    expect((await create(keys.testAdmin.headers)).status).toBe(403);
    t.fixture.kit.clock.advance(2000);
    for (const k of [keys.revoked, keys.expired])
      await expectProblem(await create(k.headers), 401, 'INVALID_API_KEY');
    expect([await count('scanners'), await t.auditCount()]).toEqual(before);
  });

  it('stops at 100 secrets a day, shared with the setup', async () => {
    const k = await t.key(['scanning:admin']);
    const day = Math.floor(t.fixture.kit.clock.now() / 86_400_000) * 86_400_000;
    await run(t.env().DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 99)', [
      `scan-setup:secrets:${k.id}`,
      day,
    ]);
    expect((await create(k.headers)).status).toBe(201);
    expect((await create(k.headers)).status).toBe(429);
    expect((await create(k.headers, scannerBody('terminal'))).status).toBe(201);
  });

  it('keeps the console answer: a session gets its code', async () => {
    const res = await t.fixture.call('POST', '/scanners', scannerBody());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { pairing: { code: string } }).pairing.code).toMatch(FORMAT.code);
  });
});

describe('add a device to a session by key', () => {
  let session = '';
  const add = (headers: Record<string, string>, id = session, idem?: string, name?: string) =>
    t.send(
      'POST',
      `/scanning-sessions/${id}/devices`,
      headers,
      { name: name ?? `Dev ${++n}`, surface: 'auto' },
      idem,
    );
  beforeAll(async () => {
    session = (await t.fixture.parent('Key devices')).id;
  });

  it('gives an admin key the code once, and no creator', async () => {
    const first1 = await add(keys.admin.headers, session, 'dev-once', 'Dev once');
    const replay = await add(keys.admin.headers, session, 'dev-once', 'Dev once');
    const shown = ((await first1.clone().json()) as { pairing: { code: string } }).pairing.code;
    await t.expectOnce({
      first: first1,
      replay,
      secrets: { 'pairing.code': FORMAT.code, 'pairing.url': FORMAT.url },
      ids: ['id'],
      keyId: keys.admin.id,
      action: 'scanner.pairing_create',
      target: (one) => String(one.id),
      reads: [],
    });
    const id = ((await first1.json()) as { id: string }).id;
    expect(
      await first(t.env().DB, 'SELECT created_by, pair_created_by FROM scanners WHERE id = ?', [
        id,
      ]),
    ).toEqual({ created_by: null, pair_created_by: null });
    expect(
      ((await first1.json().catch(() => ({}))) as { adminName?: unknown }).adminName ?? null,
    ).toBeNull();
    expect((await redeem(shown)).status).toBe(200);
  });

  it('gives a write key a device with no code', async () => {
    const res = await add(keys.write.headers);
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; pairing: unknown };
    expect(made.pairing).toBeNull();
    expect(await t.keyAudit(made.id, 'scanner.pairing_create')).toHaveLength(0);
    expect(
      await first(t.env().DB, 'SELECT pair_code_hash FROM scanners WHERE id = ?', [made.id]),
    ).toEqual({ pair_code_hash: null });
  });

  it('refuses keys that may not, and a session of another mode', async () => {
    const before = [await count('scanners'), await t.auditCount()];
    await expectProblem(await add(keys.read.headers), 403, 'MISSING_SCOPE');
    for (const k of [keys.platform, keys.otherOrg])
      await expectProblem(await add(k.headers), 404, 'SCANNING_SESSION_NOT_FOUND');
    const test = await t.key(['scanning:write'], { mode: 'test' });
    await expectProblem(await add(test.headers), 404, 'SCANNING_SESSION_NOT_FOUND');
    await expectProblem(await add(keys.restricted.headers), 403, 'API_KEY_RESTRICTED_ROUTE');
    t.fixture.kit.clock.advance(2000);
    for (const k of [keys.revoked, keys.expired])
      await expectProblem(await add(k.headers), 401, 'INVALID_API_KEY');
    expect([await count('scanners'), await t.auditCount()]).toEqual(before);
  });

  it('refuses a paused session with 409 and refunds the charge', async () => {
    const paused = (await t.fixture.parent('Key paused')).id;
    expect(
      (await t.fixture.call('PATCH', `/scanning-sessions/${paused}`, { status: 'paused' })).status,
    ).toBe(200);
    const k = await t.key(['scanning:admin']);
    for (let i = 0; i < 3; i++)
      await expectProblem(await add(k.headers, paused), 409, 'SCANNING_SESSION_PAUSED');
    const rows = await all<{ count: number }>(
      t.env().DB,
      'SELECT count FROM counters WHERE key LIKE ?',
      [`%${k.id}`],
    );
    expect(rows.every((r) => r.count === 0)).toBe(true);
  });

  it('keeps the console answer: a session gets its code', async () => {
    const res = await t.fixture.call('POST', `/scanning-sessions/${session}/devices`, {
      name: `Console ${++n}`,
      surface: 'auto',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { pairing: { code: string } }).pairing.code).toMatch(FORMAT.code);
  });
});
