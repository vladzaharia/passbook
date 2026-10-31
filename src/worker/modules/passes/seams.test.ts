import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { enqueuePush } from '../delivery/service.ts';
import { getPass } from './repo.ts';
import {
  applyConnectionRecord,
  createPassFromConnection,
  markPassMissing,
  requestRefresh,
} from './service.ts';
import { type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function connection(generation = 1) {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'c', ?, 1, 1)`,
    [id, kit.org.id, generation],
  );
  return id;
}

describe('requestRefresh', () => {
  const jobs = () => kit.queue.sent.filter((m) => (m as { kind: string }).kind === 'pass.refresh');

  it('claims the slot, enqueues one job and coalesces repeats inside the window', async () => {
    const pass = await kit.pass();
    kit.queue.sent.length = 0;
    const a = await requestRefresh(kit.ctx, pass.id, { type: 'user', id: 'u1' });
    expect(a.coalesced).toBe(false);
    expect(jobs()).toEqual([
      { kind: 'pass.refresh', passId: pass.id, trigger: 'user', actorId: 'u1' },
    ]);
    const b = await requestRefresh(kit.ctx, pass.id, { type: 'user', id: 'u1' });
    expect(b).toEqual({ requestedAt: a.requestedAt, coalesced: true });
    expect(jobs()).toHaveLength(1);
    kit.clock.advance(31_000);
    const c = await requestRefresh(kit.ctx, pass.id, { type: 'user', id: 'admin-1' });
    expect(c.coalesced).toBe(false);
    expect(c.requestedAt).toBeGreaterThan(a.requestedAt);
    expect(jobs()).toHaveLength(2);
  });

  it('reports admin triggers and unknown passes', async () => {
    const pass = await kit.pass();
    kit.queue.sent.length = 0;
    await requestRefresh(kit.ctx, pass.id, { type: 'api_key', id: 'k1' });
    expect(jobs()[0]).toMatchObject({ trigger: 'admin', actorId: 'k1' });
    await expect(
      requestRefresh(kit.ctx, 'missing', { type: 'user', id: 'u' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('enqueuePush', () => {
  it('coalesces until the first push starts, then queues a fresh one', async () => {
    const pass = await kit.pass();
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await enqueuePush(kit.ctx, pass.id, 'publish');
    const rows = () =>
      all<{ id: string }>(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
        pass.id,
      ]);
    expect(await rows()).toHaveLength(1);
    await run(
      kit.env.DB,
      "UPDATE outbox SET state = 'processing', coalesce_key = NULL WHERE pass_id = ?",
      [pass.id],
    );
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    expect(await rows()).toHaveLength(2);
    await kit.settle();
  });

  it('rejects unknown passes', async () => {
    await expect(enqueuePush(kit.ctx, 'missing', 'refresh')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createPassFromConnection', () => {
  it('creates a connection-sourced pass once per external ref and can email the holder', async () => {
    const connectionId = await connection();
    const input = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      connectionId,
      externalRef: 'ref-1',
      fields: { memberName: 'Upstream Person' },
      holderEmail: 'upstream@example.com',
      sendEmail: true,
    };
    const { passId } = await createPassFromConnection(kit.ctx, input);
    const again = await createPassFromConnection(kit.ctx, input);
    expect(again.passId).toBe(passId);
    const pass = await getPass(kit.env.DB, passId);
    expect(pass).toMatchObject({
      connectionId,
      externalRef: 'ref-1',
      fieldSources: { memberName: 'connection' },
      holderEmail: 'upstream@example.com',
    });
    const mail = await all(
      kit.env.DB,
      "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [passId],
    );
    expect(mail).toHaveLength(1);
    const version = await first<{ cause: string; actor_type: string }>(
      kit.env.DB,
      'SELECT cause, actor_type FROM pass_versions WHERE pass_id = ?',
      [passId],
    );
    expect(version).toEqual({ cause: 'create', actor_type: 'connection' });
  });

  it('does not email when sendEmail is off and refuses a connection from another org', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      connectionId,
      externalRef: 'ref-2',
      fields: { memberName: 'Quiet' },
      holderEmail: 'quiet@example.com',
      sendEmail: false,
    });
    expect(
      await all(kit.env.DB, "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]),
    ).toHaveLength(0);
    await expect(
      createPassFromConnection(kit.ctx, {
        orgId: 'other-org',
        templateId: kit.template.id,
        connectionId,
        externalRef: 'ref-3',
        fields: { memberName: 'x' },
        sendEmail: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('applyConnectionRecord', () => {
  it('rejects a pass linked to another connection and does not publish unchanged data', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      connectionId,
      externalRef: 'ref-a',
      fields: { memberName: 'Same' },
      sendEmail: false,
    });
    const base = { passId, connectionId, generation: 1, cause: 'connection' as const };
    expect(
      await applyConnectionRecord(kit.ctx, { ...base, fields: { memberName: 'Same' } }),
    ).toEqual({
      changed: false,
      version: 1,
    });
    await expect(
      applyConnectionRecord(kit.ctx, { ...base, connectionId: await connection(), fields: {} }),
    ).rejects.toMatchObject({ code: 'PASS_CONNECTION_MISMATCH' });
    const changed = await applyConnectionRecord(kit.ctx, {
      ...base,
      fields: { memberName: 'New' },
    });
    expect(changed).toEqual({ changed: true, version: 2 });
    const cause = await first<{ cause: string; actor_type: string }>(
      kit.env.DB,
      'SELECT cause, actor_type FROM pass_versions WHERE pass_id = ? AND version = 2',
      [passId],
    );
    expect(cause).toEqual({ cause: 'connection', actor_type: 'connection' });
  });

  it('sets the holder email only while the pass is unowned', async () => {
    const connectionId = await connection();
    const mk = async (ref: string) =>
      (
        await createPassFromConnection(kit.ctx, {
          orgId: kit.org.id,
          templateId: kit.template.id,
          connectionId,
          externalRef: ref,
          fields: { memberName: 'H' },
          sendEmail: false,
        })
      ).passId;
    const free = await mk('h-free');
    const taken = await mk('h-taken');
    const owner = await makeUser(kit.fx);
    await run(kit.env.DB, 'UPDATE passes SET owner_user_id = ?, holder_email = ? WHERE id = ?', [
      owner.id,
      'owner@example.com',
      taken,
    ]);
    const base = { connectionId, generation: 1, fields: {}, cause: 'connection' as const };
    await applyConnectionRecord(kit.ctx, { ...base, passId: free, holderEmail: 'new@example.com' });
    await applyConnectionRecord(kit.ctx, {
      ...base,
      passId: taken,
      holderEmail: 'other@example.com',
    });
    expect((await getPass(kit.env.DB, free))?.holderEmail).toBe('new@example.com');
    expect((await getPass(kit.env.DB, taken))?.holderEmail).toBe('owner@example.com');
  });
});

describe('markPassMissing', () => {
  it('flags without changing the pass, then a good record clears the flag', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      connectionId,
      externalRef: 'gone',
      fields: { memberName: 'Gone' },
      sendEmail: false,
    });
    await markPassMissing(kit.ctx, passId, 'flag');
    expect(await getPass(kit.env.DB, passId)).toMatchObject({
      syncErrorCode: 'RECORD_MISSING',
      status: 'active',
      version: 1,
    });
    await applyConnectionRecord(kit.ctx, {
      passId,
      connectionId,
      generation: 1,
      fields: { memberName: 'Gone' },
      cause: 'connection',
    });
    expect((await getPass(kit.env.DB, passId))?.syncErrorCode).toBeNull();
  });

  it('voids the pass and keeps the flag in void mode', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      connectionId,
      externalRef: 'void-me',
      fields: { memberName: 'V' },
      sendEmail: false,
    });
    await markPassMissing(kit.ctx, passId, 'void');
    expect(await getPass(kit.env.DB, passId)).toMatchObject({
      status: 'voided',
      syncErrorCode: 'RECORD_MISSING',
      version: 2,
    });
    // A second call does not publish again.
    await markPassMissing(kit.ctx, passId, 'void');
    expect((await getPass(kit.env.DB, passId))?.version).toBe(2);
  });
});
