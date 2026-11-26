import { describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { hashScimToken } from './scim-tokens.ts';
import {
  admin,
  installSetupRig,
  opOf,
  read,
  rig,
  runNext,
  SETUP,
  start,
} from './setup-test-fixtures.ts';

installSetupRig();

const ROTATE = '/api/v1/platform/idp/scim-token/rotate';

/** Every group placed and allowed, and the app restricted: what rotating needs. */
function restricted() {
  rig.idp.groupStore.set('support', {
    kind: 'role',
    name: 'passbook_support',
    friendlyName: 'passbook_support',
    otherClients: 0,
  });
  for (const g of ['console', 'developer', 'support', 'platform_admin'])
    rig.idp.setup.client.allowed.add(g);
  rig.idp.setup.client.restricted = true;
}

/** A connection holds a first token, as after a setup. */
async function connected() {
  const a = await admin();
  restricted();
  const setup = await opOf(
    await start(SETUP, 'POST', a.headers, { dryRun: false, items: ['scim_provider'] }),
  );
  await runNext(setup);
  return a;
}

const states = () =>
  all<{ state: string; token_sha256: string }>(
    rig.h.env.DB,
    'SELECT state, token_sha256 FROM idp_scim_tokens ORDER BY created_at',
  );

describe('rotate', () => {
  it('is a dry run by default: no token, no write, no audit row', async () => {
    const a = await connected();
    const before = await states();
    const writes = rig.idp.writes;
    const op = await opOf(await start(ROTATE, 'POST', a.headers));
    expect(op).toMatchObject({ kind: 'idp.scim_rotate', target: { id: 'dry' } });
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.result?.ids).toEqual({ dryRun: 'yes', scim_token: 'would' });
    expect(await states()).toEqual(before);
    expect(rig.idp.writes).toBe(writes);
    expect(
      await all(rig.h.env.DB, "SELECT id FROM audit_log WHERE action = 'idp.scim_rotate'"),
    ).toEqual([]);
  });

  it('gives Polaris ID the new token first, then switches, and retires the old one', async () => {
    const a = await connected();
    const old = rig.idp.setup.scim.token as string;
    const op = await opOf(await start(ROTATE, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done']);
    const fresh = rig.idp.setup.scim.token as string;
    expect(fresh).not.toBe(old);
    const rows = await states();
    expect(rows.map((r) => r.state)).toEqual(['retired', 'active']);
    expect(rows[1]?.token_sha256).toBe(await hashScimToken(fresh));
    expect(
      await all(rig.h.env.DB, "SELECT id FROM audit_log WHERE action = 'idp.scim_rotate'"),
    ).toHaveLength(1);
    const dump = JSON.stringify({
      ops: await all(rig.h.env.DB, 'SELECT * FROM operations'),
      audit: await all(rig.h.env.DB, 'SELECT * FROM audit_log'),
      api: done,
    });
    expect(dump).not.toContain(fresh);
    expect(dump).not.toContain(old);
  });

  it('refuses with IDP_SCIM_MISSING when there is no connection to rotate', async () => {
    const a = await admin();
    restricted();
    for (const dryRun of [true, false]) {
      const op = await opOf(await start(ROTATE, 'POST', a.headers, { dryRun }));
      await runNext(op);
      expect((await read(op.id, a.headers)).error?.code).toBe('IDP_SCIM_MISSING');
      await run(rig.h.env.DB, 'DELETE FROM operations');
    }
    expect(rig.idp.setup.scim.exists).toBe(false);
    expect(await states()).toEqual([]);
  });

  it('refuses an app that is not restricted and a connection pointed elsewhere', async () => {
    const a = await admin();
    const open = await opOf(await start(ROTATE, 'POST', a.headers, { dryRun: false }));
    await runNext(open);
    expect((await read(open.id, a.headers)).error?.code).toBe('IDP_CLIENT');
    expect(await states()).toEqual([]);
    restricted();
    rig.idp.setup.scim = { exists: true, foreign: true, token: 'y'.repeat(43), lastSyncedAt: null };
    const foreign = await opOf(await start(ROTATE, 'POST', a.headers, { dryRun: false }));
    await runNext(foreign);
    expect((await read(foreign.id, a.headers)).error?.code).toBe('IDP_SCIM_FOREIGN');
    expect(rig.idp.setup.scim.token).toBe('y'.repeat(43));
    expect(await first(rig.h.env.DB, 'SELECT id FROM idp_scim_tokens')).toBeNull();
  });
});
