import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { updatePass } from '../passes/service.ts';
import {
  ACCESS,
  accessTemplate,
  gateRow,
  grantOf,
  makeDoor,
  makeZone,
} from './access-test-fixtures.ts';
import { act, HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const commit = RACE_GATE_WRITE;

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
      async (db) => {
        // The unlink also bumps the session's epoch (a trigger), which is monotonic: take the trigger
        // out for this one delete so that only the link check can refuse the scan.
        await run(db, 'DROP TRIGGER scanning_session_zones_config_delete');
        await run(db, 'DELETE FROM scanning_session_zones WHERE session_id = ?', [d.sessionId]);
        await run(
          db,
          `CREATE TRIGGER scanning_session_zones_config_delete AFTER DELETE ON scanning_session_zones
           BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE id = OLD.session_id; END`,
        );
      },
      () => act(d.headers, codeOf(pass)),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    expect(await gateRow(pass.id)).toBeNull();
  });

  it('refuses a grant when the pass was suspended after the read, and writes no gate', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const { result, fired } = await beforeBatch(
      kit.env,
      commit,
      () =>
        updatePass(
          jobCtxOf(kit),
          { type: 'user', id: 'admin-1' },
          pass.id,
          { input: { status: 'Suspended' } },
          { scope: kit.org.id },
        ),
      () => act(d.headers, codeOf(pass)),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
    expect(await gateRow(pass.id)).toBeNull();
    expect(await grantOf(d.headers, pass)).toMatchObject({ reason: 'suspended' });
  });

  describe.each([
    [
      'its parent was renamed',
      (id: string, parent: string) =>
        run(kit.env.DB, 'UPDATE scan_zones SET key = ? WHERE id = ?', [
          `${id.slice(-6)}-renamed`,
          parent,
        ]),
    ],
    [
      'it was moved out of its parent',
      (id: string) => run(kit.env.DB, 'UPDATE scan_zones SET parent_id = NULL WHERE id = ?', [id]),
    ],
    [
      'its parent was archived',
      (_id: string, parent: string) =>
        run(kit.env.DB, 'UPDATE scan_zones SET archived_at = ? WHERE id = ?', [
          kit.clock.now(),
          parent,
        ]),
    ],
  ] as const)('the zone chain: %s', (_name, change) => {
    it('refuses a grant that was decided through it', async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const tpl = await accessTemplate({
        ...ACCESS,
        plans: [{ id: 'club', label: 'Club', kind: 'always', zones: [{ zone: `club-${suffix}` }] }],
      });
      const parent = await makeZone(`club-${suffix}`);
      const child = await makeZone(`room-${suffix}`, { parentId: parent });
      const d = await makeDoor([tpl], [child]);
      const pass = await kit.scanPass(tpl, { plan: 'club' });
      const { result, fired } = await beforeBatch(
        kit.env,
        commit,
        () => change(child, parent),
        () => act(d.headers, codeOf(pass)),
      );
      expect(fired).toBe(true);
      expect(result.status).toBe(409);
      expect(await gateRow(pass.id)).toBeNull();
    });
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
