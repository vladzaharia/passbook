import { describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import {
  admin,
  auditActions,
  codeOf,
  consoleCall,
  create,
  env,
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
    expect(res.status).toBe(404);
  });

  it('refuses a setup edit from the other mode', async () => {
    const { body } = await create({ name: 'Live scanner' });
    const res = await send('PATCH', `/api/v1/scan-setups/${body.id}`, admin('test'), {
      name: 'Hijacked',
    });
    expect(res.status).toBe(404);
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
