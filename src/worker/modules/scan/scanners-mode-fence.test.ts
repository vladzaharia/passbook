import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import {
  admin,
  auditActions,
  codeOf,
  consoleCall,
  create,
  env,
  f,
  fake,
  pairCall,
  send,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

setupScannerFixture();

const state = (id: string) =>
  first<{ name: string; revoked_at: number | null; mode: string; pair_code_hash: string | null }>(
    env.DB,
    'SELECT name, revoked_at, mode, pair_code_hash FROM scanners WHERE id = ?',
    [id],
  );

describe('a pending pair code dies with a mode move (L1)', () => {
  it('a test-mode code cannot redeem a live credential', async () => {
    const { body } = await create({ name: 'Test door' }, admin('test'));
    const code = body.pairing?.code ?? '';
    expect(
      (await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' }, admin('test'))).status,
    ).toBe(200);
    expect((await state(body.id))?.pair_code_hash).toBeNull();
    const preview = await pairCall('/preview', code);
    expect(preview.status).toBe(400);
    const redeem = await pairCall('', code);
    expect(redeem.status).toBe(400);
    expect(await codeOf(redeem)).toBe('PAIRING_INVALID');
    expect(redeem.headers.get('set-cookie') ?? '').not.toContain('scanner');
  });
});

describe('by-id scanner routes hide foreign ids (L5)', () => {
  it('answers a non-member exactly as it answers a missing id', async () => {
    const { body } = await create({ name: 'Hidden' });
    const outsider = await makeUser(f);
    const headers = fake.session({ userId: outsider.id, roles: ['admin', 'user'] });
    const missing = '0190aaaa-0000-7000-8000-000000000000';
    const routes: [string, string, string, unknown?][] = [
      ['GET', '', '/api/v1/scanners'],
      ['PATCH', '', '/api/v1/scanners', { name: 'x' }],
      ['POST', '/pairing', '/api/v1/scanners'],
      ['POST', '/revoke', '/api/v1/scanners'],
      ['POST', '/sample-pass', '/api/v1/scanners'],
      ['GET', '', '/api/v1/scan-setups'],
      ['PATCH', '', '/api/v1/scan-setups', { name: 'x' }],
    ];
    for (const [method, tail, base, data] of routes) {
      const foreign = await send(method, `${base}/${body.id}${tail}`, headers, data);
      const absent = await send(method, `${base}/${missing}${tail}`, headers, data);
      expect([method, base, tail, foreign.status]).toEqual([method, base, tail, 404]);
      const strip = async (r: Response) => ({ ...((await r.json()) as object), requestId: 0 });
      expect(await strip(foreign)).toEqual(await strip(absent));
    }
    for (const [method, path] of [
      ['GET', `/api/v1/scanning-sessions/${body.id}`],
      ['GET', `/api/v1/scanning-sessions/${missing}`],
    ] as const) {
      expect([path, (await send(method, path, headers)).status]).toEqual([path, 404]);
    }
  });
});

describe('the console edits only scanners of its own mode', () => {
  it('refuses edit, revoke, re-pair, pair-here and mode move from the other mode', async () => {
    const { body } = await create({ name: 'Live door' });
    const before = await state(body.id);
    const test = admin('test');
    const attempts: [string, string, unknown?][] = [
      ['GET', ''],
      ['PATCH', '', { name: 'Hijacked' }],
      ['POST', '/pairing'],
      ['POST', '/pair-here'],
      ['POST', '/revoke'],
      ['POST', '/mode', { mode: 'test' }],
    ];
    for (const [method, path, data] of attempts) {
      const res = await consoleCall(method, `/${body.id}${path}`, data, test);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(await state(body.id)).toEqual(before);
    expect((await auditActions()).filter((a) => a === 'scanner.revoke')).toHaveLength(0);
  });

  it('refuses a token replacement from the other mode', async () => {
    const { body } = await create({ kind: 'terminal', name: 'Live till' });
    const res = await consoleCall('POST', `/${body.id}/token`, undefined, admin('test'));
    await expectProblem(res, 404, 'SCANNER_NOT_FOUND');
  });

  it('refuses a setup edit from the other mode', async () => {
    const { body } = await create({ name: 'Live scanner' });
    const res = await send('PATCH', `/api/v1/scan-setups/${body.id}`, admin('test'), {
      name: 'Hijacked',
    });
    await expectProblem(res, 404, 'SCANNER_NOT_FOUND');
    expect((await state(body.id))?.name).toBe('Live scanner');
  });

  it('answers 200 to a second revoke that races the first', async () => {
    const { body } = await create({ name: 'Racing' });
    const [a, b] = await Promise.all([
      consoleCall('POST', `/${body.id}/revoke`),
      consoleCall('POST', `/${body.id}/revoke`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await state(body.id))?.revoked_at).not.toBeNull();
    expect((await auditActions()).filter((x) => x === 'scanner.revoke')).toHaveLength(1);
  });

  it('refuses to pair a revoked scanner unless the call restores it', async () => {
    const { body } = await create({ name: 'Removed' });
    await consoleCall('POST', `/${body.id}/revoke`);
    for (const path of ['/pairing', '/pair-here']) {
      const res = await consoleCall('POST', `/${body.id}${path}`);
      expect([path, res.status, await codeOf(res)]).toEqual([path, 409, 'SCANNER_REVOKED']);
    }
    expect((await state(body.id))?.revoked_at).not.toBeNull();
    expect((await state(body.id))?.pair_code_hash).toBeNull();
    const restored = await consoleCall('POST', `/${body.id}/pairing?restore=true`);
    expect(restored.status).toBe(200);
    expect((await state(body.id))?.revoked_at).toBeNull();
    expect(await auditActions()).toContain('scanner.restore');
  });
});
