import { describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { upsertGroup, upsertUser } from './repo-scim.ts';
import { hashScimToken } from './scim-tokens.ts';
import {
  activeCount,
  admin,
  idsOf,
  installSetupRig,
  opOf,
  pushSeen,
  read,
  rig,
  runNext,
  SETUP,
  setupOnce,
  start,
} from './setup-test-fixtures.ts';

installSetupRig();

const tokens = () =>
  all<{ state: string }>(rig.h.env.DB, 'SELECT state FROM idp_scim_tokens ORDER BY created_at');

/** A full live setup: it waits for the first push and the directory copy, which the test supplies. */
async function liveSetup() {
  const a = await admin();
  const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
  await runNext(op);
  expect((await read(op.id, a.headers)).status).toBe('waiting');
  await pushSeen();
  await runNext(op);
  const now = rig.h.clock.now();
  await upsertUser(rig.h.env.DB, { scimId: 'u1', subject: 'sub-1', active: true, now });
  await upsertGroup(rig.h.env.DB, { scimId: 'g1', groupId: 'grp-1', members: ['u1'], now });
  await runNext(op);
  return { a, op, done: await read(op.id, a.headers) };
}

describe('dry run', () => {
  it('writes nothing anywhere: no Polaris ID write, no token, no audit row, no state change', async () => {
    const { done } = await setupOnce({});
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(idsOf(done)).toMatchObject({
      dryRun: 'yes',
      groups: 'would',
      client_groups: 'after',
      client_restricted: 'after',
      scim_token: 'after',
      scim_provider: 'after',
      scim_sync: 'after',
      scim_mirror: 'after',
    });
    expect(done.steps.map((s) => s.state)).toEqual(Array(9).fill('done').fill('skipped', 1));
    expect(rig.idp.writes).toBe(0);
    expect(await tokens()).toEqual([]);
    expect(rig.idp.setup.client.restricted).toBe(false);
    expect(rig.idp.log).not.toContain('ensureScim');
    expect(
      await all(rig.h.env.DB, "SELECT id FROM audit_log WHERE action LIKE 'idp.setup%'"),
    ).toEqual([]);
  });

  it('previews each step the state allows, and mints nothing for the connection', async () => {
    rig.idp.groupStore.set('support', {
      kind: 'role',
      name: 'passbook_support',
      friendlyName: 'passbook_support',
      otherClients: 0,
    });
    for (const g of ['console', 'developer', 'support', 'platform_admin'])
      rig.idp.setup.client.allowed.add(g);
    rig.idp.setup.client.restricted = true;
    const { done } = await setupOnce({});
    expect(idsOf(done)).toMatchObject({
      groups: 'done',
      client_groups: 'done',
      client_restricted: 'done',
      client_logo: 'would',
      scim_token: 'would',
      scim_provider: 'would',
      scim_sync: 'after',
    });
    expect(rig.idp.writes).toBe(0);
    expect(rig.idp.setup.scim.exists).toBe(false);
    expect(await tokens()).toEqual([]);
  });

  it('counts the groups it would allow', async () => {
    const { done } = await setupOnce({ items: ['groups'] });
    expect(idsOf(done)).toMatchObject({ groups: 'would', client_groups: 'skipped' });
  });
});

describe('live run', () => {
  it('sets everything up, stops to wait for Polaris ID, and ends done', async () => {
    const { done } = await liveSetup();
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(idsOf(done)).toMatchObject({
      dryRun: 'no',
      groups: 'done',
      // The run resumed twice: what it did before the wait reads as done.
      scim_sync: 'done',
      scim_mirror: 'done',
    });
    const s = rig.idp.setup;
    expect(s.client).toMatchObject({ restricted: true, logo: true, darkLogo: true });
    expect(s.client.allowed.has('platform_admin')).toBe(true);
    expect(rig.idp.groupStore.has('support')).toBe(true);
    expect(s.scim.exists).toBe(true);
    expect(await tokens()).toEqual([{ state: 'active' }]);
    const audit = await all<{ action: string }>(
      rig.h.env.DB,
      "SELECT action FROM audit_log WHERE action LIKE 'idp.setup%' ORDER BY action",
    );
    expect(audit.map((r) => r.action)).toEqual([
      'idp.setup',
      'idp.setup.client_groups',
      'idp.setup.client_logo',
      'idp.setup.client_restricted',
      'idp.setup.groups',
      'idp.setup.scim_sync',
      'idp.setup.scim_token',
    ]);
    for (const r of audit) expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('a second live run is a no-op: no write, no mint, no connection call', async () => {
    const { a } = await liveSetup();
    const writes = rig.idp.writes;
    const calls = rig.idp.log.length;
    const again = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(again);
    const done = await read(again.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(Object.values(idsOf(done)).filter((v) => v === 'changed')).toEqual([]);
    expect(rig.idp.writes).toBe(writes);
    expect(rig.idp.log.slice(calls).filter((m) => m !== 'health' && m !== 'setupStatus')).toEqual(
      [],
    );
    expect(await tokens()).toEqual([{ state: 'active' }]);
  });

  it('stops at the first blocked item with its reason, and writes nothing after', async () => {
    rig.idp.groupStore.delete('support');
    rig.idp.setup.existing.support = 'in_use';
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    const failed = await read(op.id, a.headers);
    expect(failed.error).toMatchObject({ code: 'IDP_SETUP_GROUP_IN_USE', step: 'groups' });
    expect(failed.error?.message).toMatch(/another app/);
    expect(rig.idp.writes).toBe(0);
    expect(await tokens()).toEqual([]);
  });

  it('stops before any step when the PassBook app is not there', async () => {
    rig.idp.setup.client.found = false;
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    expect((await read(op.id, a.headers)).error).toMatchObject({
      code: 'IDP_SETUP_CLIENT_MISSING',
      step: 'check',
    });
    expect(rig.idp.writes).toBe(0);
  });

  it('never overwrites a connection the owner pointed elsewhere', async () => {
    rig.idp.setup.scim = { exists: true, foreign: true, token: 'x'.repeat(43), lastSyncedAt: null };
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    expect((await read(op.id, a.headers)).error).toMatchObject({
      code: 'IDP_SCIM_FOREIGN',
      step: 'scim_provider',
    });
    expect(rig.idp.setup.scim.token).toBe('x'.repeat(43));
    expect(await tokens()).toEqual([]);
  });

  it('a failed logo does not stop the items after it', async () => {
    rig.idp.failNext('IDP_UPSTREAM', 'setClientLogo');
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    const waiting = await read(op.id, a.headers);
    expect(waiting.status, JSON.stringify(waiting.error)).toBe('waiting');
    expect(waiting.steps.find((s) => s.key === 'client_logo')?.state).toBe('skipped');
    expect(await activeCount()).toBe(1);
  });

  it('fails when no push arrives within ten minutes, and on an empty copy', async () => {
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    rig.h.clock.advance(11 * 60_000);
    await runNext(op);
    expect((await read(op.id, a.headers)).error).toMatchObject({
      code: 'IDP_SETUP_SCIM_PUSH',
      step: 'scim_sync',
    });
    const b = await admin();
    const again = await opOf(await start(SETUP, 'POST', b.headers, { dryRun: false }));
    await run(rig.h.env.DB, "UPDATE idp_scim_tokens SET last_auth_at = ? WHERE state = 'active'", [
      rig.h.clock.now(),
    ]);
    await runNext(again);
    expect((await read(again.id, b.headers)).status).toBe('waiting');
    rig.h.clock.advance(11 * 60_000);
    await run(rig.h.env.DB, "UPDATE idp_scim_tokens SET last_auth_at = ? WHERE state = 'active'", [
      rig.h.clock.now(),
    ]);
    await runNext(again);
    expect((await read(again.id, b.headers)).error).toMatchObject({
      code: 'IDP_SETUP_MIRROR_EMPTY',
      step: 'scim_mirror',
    });
  });
});

describe('the SCIM token', () => {
  it('never appears in an operation, an audit row, a log row or a job', async () => {
    const { done } = await liveSetup();
    expect(done.status).toBe('succeeded');
    const token = rig.idp.setup.scim.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify({
      operations: await all(rig.h.env.DB, 'SELECT * FROM operations'),
      audit: await all(rig.h.env.DB, 'SELECT * FROM audit_log'),
      tokens: await all(rig.h.env.DB, 'SELECT * FROM idp_scim_tokens'),
      api: done,
      jobs: rig.queue.jobs,
    });
    expect(dump).not.toContain(token as string);
    const row = await first<{ token_sha256: string }>(
      rig.h.env.DB,
      "SELECT token_sha256 FROM idp_scim_tokens WHERE state = 'active'",
    );
    expect(row?.token_sha256).toBe(await hashScimToken(token as string));
  });

  it('mints again when the flip fails, and activates only the token Polaris ID holds', async () => {
    const real = rig.idp.ensureScim.bind(rig.idp);
    let calls = 0;
    rig.idp.ensureScim = async (token, ctx) => {
      const out = await real(token, ctx);
      // The pending row is retired right after Polaris ID took the token: the flip must refuse it.
      if (++calls === 1)
        await run(
          rig.h.env.DB,
          "UPDATE idp_scim_tokens SET state = 'retired', retired_at = ? WHERE state = 'pending'",
          [rig.h.clock.now()],
        );
      return out;
    };
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    expect(calls).toBe(2);
    const held = rig.idp.setup.scim.token as string;
    const active = await first<{ token_sha256: string }>(
      rig.h.env.DB,
      "SELECT token_sha256 FROM idp_scim_tokens WHERE state = 'active'",
    );
    expect(active?.token_sha256).toBe(await hashScimToken(held));
  });

  it('gives up after two failed flips with a retryable stop', async () => {
    const real = rig.idp.ensureScim.bind(rig.idp);
    rig.idp.ensureScim = async (token, ctx) => {
      const out = await real(token, ctx);
      await run(
        rig.h.env.DB,
        "UPDATE idp_scim_tokens SET state = 'retired', retired_at = ? WHERE state = 'pending'",
        [rig.h.clock.now()],
      );
      return out;
    };
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    expect((await read(op.id, a.headers)).error).toMatchObject({
      code: 'IDP_SETUP_TOKEN',
      retryable: true,
    });
    expect(await activeCount()).toBe(0);
  });
});
