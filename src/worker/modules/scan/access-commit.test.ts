import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { accessTemplate, gateRow, grantOf, makeDoor, makeZone } from './access-test-fixtures.ts';
import { act, HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const commit = /INSERT INTO scan_gates/;

describe('access: what holds at commit (C6)', () => {
  it('refuses a grant whose zone was archived after the read, and writes no gate', async () => {
    const tpl = await accessTemplate();
    const zone = await makeZone('closing-room');
    const d = await makeDoor([tpl], [zone]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const { result, fired } = await beforeBatch(
      kit.env,
      commit,
      (db) =>
        run(db, 'UPDATE scan_zones SET archived_at = ? WHERE id = ?', [kit.clock.now(), zone]),
      () => act(d.headers, codeOf(pass)),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    expect(await gateRow(pass.id)).toBeNull();
    // The next scan reads the zone as archived.
    expect(await grantOf(d.headers, pass)).toMatchObject({ reason: 'zone_not_included' });
  });

  it('refuses a grant whose zone link was removed after the read', async () => {
    const tpl = await accessTemplate();
    const zone = await makeZone('moving-room');
    const d = await makeDoor([tpl], [zone]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const { result } = await beforeBatch(
      kit.env,
      commit,
      (db) => run(db, 'DELETE FROM scanning_session_zones WHERE session_id = ?', [d.sessionId]),
      () => act(d.headers, codeOf(pass)),
    );
    expect(result.status).toBe(409);
    expect(await gateRow(pass.id)).toBeNull();
  });

  it('reports a guest whose pass has expired as guest_expired, and a member as expired', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const past = new Date(kit.clock.now() - HOUR).toISOString();
    const expire = (id: string) =>
      run(
        kit.env.DB,
        `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
        [past, id],
      );
    const guest = await kit.scanPass(tpl, { plan: 'guest' });
    const member = await kit.scanPass(tpl, { plan: 'gold' });
    await expire(guest.id);
    await expire(member.id);
    expect((await grantOf(d.headers, guest)).reason).toBe('guest_expired');
    expect((await grantOf(d.headers, member)).reason).toBe('expired');
  });
});
