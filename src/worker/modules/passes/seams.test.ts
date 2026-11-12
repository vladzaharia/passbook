import { beforeAll, describe, expect, it } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { beginTransfer, interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePush } from '../delivery/service.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { applyConnectionRecord, markPassMissing } from './connection-passes.ts';
import { createPassFromConnection } from './connection-passes-create.ts';
import { ensureCredentialRefKeyset, requireCredentialRefKeyset } from './credential-keyset.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { claimRefresh } from './repo.ts';
import { getPass } from './repo-read-pass.ts';

let kit: Kit;
let liveRelease: TemplateRelease;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  kit = await setupKit();
  liveRelease = await requireApprovedRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
}, 60_000);

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

const connectionInput = (connectionId: string, externalRef: string) => ({
  orgId: kit.org.id,
  templateId: kit.template.id,
  expectedRelease: {
    id: liveRelease.id,
    generation: liveRelease.generation,
    version: liveRelease.version,
  },
  mode: 'live' as const,
  generation: 1,
  credentialKeysetCommitment,
  expectedConnectionMode: 'poll' as const,
  connectionId,
  externalRef,
  sendEmail: false,
});

const connectionSnapshot = async (passId: string, connectionId: string, externalRef: string) => {
  const pass = await getPass(kit.env.DB, passId);
  if (!pass) throw new Error('Created pass not found');
  const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
  return {
    passId,
    orgId: pass.orgId,
    identityId: pass.identityId,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    mode: 'live' as const,
    status: pass.status,
    expectedVersion: pass.version,
    ownerUserId: pass.ownerUserId,
    linkGeneration: pass.linkGeneration,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    credentialKeysetCommitment,
    transferPending: false,
    connectionId,
    externalRef,
    generation: 1,
    expectedConnectionMode: 'poll' as const,
  };
};

describe('requestRefresh', () => {
  const isRefresh = (message: unknown) =>
    message !== null &&
    typeof message === 'object' &&
    'kind' in message &&
    message.kind === 'pass.refresh';
  const jobs = () => kit.queue.sent.filter(isRefresh);

  it('claims the slot, enqueues one job and coalesces repeats inside the window', async () => {
    const pass = await kit.pass();
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const expected = { ...pass, ownerUserId: pass.ownerUserId ?? undefined };
    kit.queue.sent.length = 0;
    const a = await requestRefresh(jobCtxOf(kit), pass.id, { type: 'user', id: 'u1' }, expected);
    expect(a.coalesced).toBe(false);
    expect(jobs()).toEqual([
      {
        kind: 'pass.refresh',
        passId: pass.id,
        orgId: pass.orgId,
        identityId: pass.identityId,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        mode: pass.mode,
        passVersion: pass.version,
        status: pass.status,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        credentialKeysetCommitment,
        connectionId: pass.connectionId,
        externalRef: pass.externalRef,
        generation: null,
        connectionMode: null,
        trigger: 'user',
        actorId: 'u1',
      },
    ]);
    const b = await requestRefresh(jobCtxOf(kit), pass.id, { type: 'user', id: 'u1' }, expected);
    expect(b).toEqual({ requestedAt: a.requestedAt, coalesced: true, cooldownSeconds: 30 });
    expect(jobs()).toHaveLength(1);
    kit.clock.advance(31_000);
    const c = await requestRefresh(
      jobCtxOf(kit),
      pass.id,
      { type: 'user', id: 'admin-1' },
      expected,
    );
    expect(c.coalesced).toBe(false);
    expect(c.requestedAt).toBeGreaterThan(a.requestedAt);
    expect(jobs()).toHaveLength(2);
  });

  it('reports admin triggers and unknown passes', async () => {
    const pass = await kit.pass();
    const expected = { ...pass, ownerUserId: pass.ownerUserId ?? undefined };
    kit.queue.sent.length = 0;
    await requestRefresh(jobCtxOf(kit), pass.id, { type: 'api_key', id: 'k1' }, expected);
    expect(jobs()[0]).toMatchObject({ trigger: 'admin', actorId: 'k1' });
    await expect(
      requestRefresh(jobCtxOf(kit), 'missing', { type: 'user', id: 'u' }, expected),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects missing, malformed, or stale credential and lifecycle snapshots before claiming', async () => {
    const pass = await kit.pass();
    const expected = { ...pass, ownerUserId: pass.ownerUserId ?? undefined };
    const before = await first(
      kit.env.DB,
      'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
      [pass.id],
    );
    kit.queue.sent.length = 0;
    for (const invalid of [
      { identityId: undefined },
      { templateId: undefined },
      { templateVersion: undefined },
      { releaseId: undefined },
      { templateId: 'other-template' },
      { templateVersion: 'other-version' },
      { releaseId: 'other-release' },
      { connectionMode: 'poll' },
      { credentialKeysetCommitment: 'invalid' },
      {
        credentialKeysetCommitment:
          credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
      },
      { credentialGeneration: undefined },
      { lifecycleGeneration: undefined },
      { credentialGeneration: 0 },
      { lifecycleGeneration: -1 },
      { credentialGeneration: pass.credentialGeneration + 1 },
      { lifecycleGeneration: pass.lifecycleGeneration + 1 },
    ]) {
      await expect(
        requestRefresh(jobCtxOf(kit), pass.id, { type: 'user', id: 'u1' }, {
          ...expected,
          ...invalid,
        } as never),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    }
    expect(
      await first(
        kit.env.DB,
        'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual(before);
    expect(jobs()).toEqual([]);
  });

  it('fences the refresh claim to the captured connection strategy', async () => {
    const pass = await kit.pass();
    const commitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const snapshot = {
      passId: pass.id,
      orgId: pass.orgId,
      identityId: pass.identityId,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
      mode: pass.mode,
      status: pass.status,
      passVersion: pass.version,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      credentialKeysetCommitment: commitment,
      connectionId: pass.connectionId,
      externalRef: pass.externalRef,
      generation: null,
      connectionMode: null,
    };
    expect(
      await claimRefresh(kit.env.DB, { ...snapshot, connectionMode: 'poll' }, kit.clock.now(), 0),
    ).toBe(false);
    expect(
      await first(kit.env.DB, 'SELECT refresh_requested_at FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ refresh_requested_at: null });
    expect(await claimRefresh(kit.env.DB, snapshot, kit.clock.now(), 0)).toBe(true);
  });

  it('does not claim or enqueue if transfer starts after authorization and before the claim', async () => {
    const pass = await kit.pass();
    const expected = { ...pass, ownerUserId: pass.ownerUserId ?? undefined };
    let afterTransfer: unknown;
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /UPDATE passes SET refresh_requested_at/i,
        when: 'before',
      },
      async () => {
        expect((await beginTransfer(kit, pass)).state).toBe('completed');
        afterTransfer = await first(
          kit.env.DB,
          'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
          [pass.id],
        );
      },
    );
    const env: AppEnv = { ...kit.env, DB: gate.db };
    kit.queue.sent.length = 0;
    await expect(
      requestRefresh({ ...kit.ctx, env }, pass.id, { type: 'user', id: 'u1' }, expected),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(gate.hits()).toBe(1);
    expect(
      await first(
        kit.env.DB,
        'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual(afterTransfer);
    expect(jobs()).toEqual([]);
    await kit.settle();
  }, 120_000);

  it('does not claim or enqueue if the authorized release binding changes before the claim', async () => {
    const pass = await kit.pass();
    expect(pass.releaseId).not.toBeNull();
    const expected = { ...pass, ownerUserId: pass.ownerUserId ?? undefined };
    let afterRace: unknown;
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /UPDATE passes SET refresh_requested_at/i,
        when: 'before',
      },
      async () => {
        await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
        afterRace = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      },
    );
    const env: AppEnv = { ...kit.env, DB: gate.db };
    kit.queue.sent.length = 0;
    await expect(
      requestRefresh({ ...kit.ctx, env }, pass.id, { type: 'user', id: 'u1' }, expected),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(gate.hits()).toBe(1);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      afterRace,
    );
    expect(jobs()).toEqual([]);
  });

  it('captures the authorized connection mode in a linked refresh job', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'refresh-mode'),
      fields: { memberName: 'Mode' },
    });
    const pass = await getPass(kit.env.DB, passId);
    if (!pass) throw new Error('Missing linked pass');
    kit.queue.sent.length = 0;
    await requestRefresh(
      jobCtxOf(kit),
      passId,
      { type: 'user', id: 'u1' },
      {
        ...pass,
        ownerUserId: pass.ownerUserId ?? undefined,
      },
    );
    expect(jobs()).toEqual([
      expect.objectContaining({
        passId,
        connectionId,
        generation: 1,
        connectionMode: 'poll',
      }),
    ]);
  });

  it('does not claim or enqueue if connection mode changes without a generation change', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'refresh-mode-race'),
      fields: { memberName: 'Mode' },
    });
    const pass = await getPass(kit.env.DB, passId);
    if (!pass) throw new Error('Missing linked pass');
    const before = await first(
      kit.env.DB,
      'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
      [passId],
    );
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /UPDATE passes SET refresh_requested_at/i,
        when: 'before',
      },
      async () => {
        await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [
          connectionId,
        ]);
      },
    );
    const env: AppEnv = { ...kit.env, DB: gate.db };
    kit.queue.sent.length = 0;
    await expect(
      requestRefresh(
        { ...kit.ctx, env },
        passId,
        { type: 'user', id: 'u1' },
        {
          ...pass,
          ownerUserId: pass.ownerUserId ?? undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(gate.hits()).toBe(1);
    expect(
      await first(
        kit.env.DB,
        'SELECT refresh_requested_at, last_refreshed_at FROM passes WHERE id = ?',
        [passId],
      ),
    ).toEqual(before);
    expect(jobs()).toEqual([]);
  });

  it('clears the old claim at transfer START without admitting a refresh while pending', async () => {
    const { kit: pendingKit, pass } = await setupSamsungCallbacks({
      db: await isolatedKeysetDatabase(),
    });
    const actor = { type: 'user', id: 'u1' } as const;
    pendingKit.queue.sent.length = 0;
    expect(
      (
        await requestRefresh(pendingKit.ctx, pass.id, actor, {
          ...pass,
          ownerUserId: pass.ownerUserId ?? undefined,
        })
      ).coalesced,
    ).toBe(false);
    expect((await beginTransfer(pendingKit, pass)).state).toBe('pending');
    expect(
      await first(pendingKit.env.DB, 'SELECT refresh_requested_at FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual({ refresh_requested_at: null });
    const current = await getPass(pendingKit.env.DB, pass.id);
    if (!current) throw new Error('Missing pending pass');
    await expect(
      requestRefresh(pendingKit.ctx, pass.id, actor, {
        ...current,
        ownerUserId: current.ownerUserId ?? undefined,
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(pendingKit.queue.sent.filter(isRefresh)).toHaveLength(1);
    expect(
      await first(pendingKit.env.DB, 'SELECT refresh_requested_at FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual({ refresh_requested_at: null });
  }, 120_000);

  it.each(['credential transfer', 'removal and restoration'] as const)(
    'queues a fresh job after %s instead of coalescing with the old incarnation',
    async (change) => {
      const pass = await kit.pass();
      kit.queue.sent.length = 0;
      const actor = { type: 'user', id: 'u1' } as const;
      expect(
        (
          await requestRefresh(jobCtxOf(kit), pass.id, actor, {
            ...pass,
            ownerUserId: pass.ownerUserId ?? undefined,
          })
        ).coalesced,
      ).toBe(false);
      if (change === 'credential transfer') {
        expect((await beginTransfer(kit, pass)).state).toBe('completed');
      } else {
        await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
        await run(kit.env.DB, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [pass.id]);
      }
      const current = await getPass(kit.env.DB, pass.id);
      if (!current) throw new Error('Missing current pass');
      expect(
        (
          await requestRefresh(jobCtxOf(kit), current.id, actor, {
            ...current,
            ownerUserId: current.ownerUserId ?? undefined,
          })
        ).coalesced,
      ).toBe(false);
      expect(jobs()).toEqual([
        expect.objectContaining({
          passId: pass.id,
          credentialGeneration: pass.credentialGeneration,
          lifecycleGeneration: pass.lifecycleGeneration,
        }),
        expect.objectContaining({
          passId: current.id,
          identityId: current.identityId,
          credentialGeneration: current.credentialGeneration,
          lifecycleGeneration: current.lifecycleGeneration,
        }),
      ]);
      await kit.settle();
    },
    120_000,
  );
});

describe('enqueuePush', () => {
  it('coalesces until the first push starts, then queues a fresh one', async () => {
    const pass = await kit.pass();
    await enqueuePush(jobCtxOf(kit), pass.id, 'refresh');
    await enqueuePush(jobCtxOf(kit), pass.id, 'publish');
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
    await enqueuePush(jobCtxOf(kit), pass.id, 'refresh');
    expect(await rows()).toHaveLength(2);
    await kit.settle();
  });

  it('rejects unknown passes', async () => {
    await expect(enqueuePush(jobCtxOf(kit), 'missing', 'refresh')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('createPassFromConnection', () => {
  it('creates a connection-sourced pass once per external ref and can email the holder', async () => {
    const connectionId = await connection();
    const input = {
      ...connectionInput(connectionId, 'ref-1'),
      fields: { memberName: 'Upstream Person' },
      holderEmail: 'upstream@example.com',
      sendEmail: true,
    };
    const { passId } = await createPassFromConnection(jobCtxOf(kit), input);
    const again = await createPassFromConnection(jobCtxOf(kit), input);
    expect(again.passId).toBe(passId);
    const pass = await getPass(kit.env.DB, passId);
    expect(pass).toMatchObject({
      connectionId,
      templateVersion: liveRelease.version,
      releaseId: liveRelease.id,
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

  it('does not return an existing winner after the admitted connection mode changes', async () => {
    const connectionId = await connection();
    const input = {
      ...connectionInput(connectionId, 'winner-mode'),
      fields: { memberName: 'Winner' },
    };
    const { passId } = await createPassFromConnection(jobCtxOf(kit), input);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [passId]);
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /SELECT generation, mode FROM connections/i,
        when: 'after',
      },
      async () => {
        await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [
          connectionId,
        ]);
      },
    );
    const env: AppEnv = { ...kit.env, DB: gate.db };
    await expect(createPassFromConnection({ ...kit.ctx, env }, input)).rejects.toMatchObject({
      code: 'PASS_CONNECTION_MISMATCH',
    });
    expect(gate.hits()).toBe(1);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [passId])).toEqual(before);
  });

  it('does not email when sendEmail is off and refuses a connection from another org', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'ref-2'),
      fields: { memberName: 'Quiet' },
      holderEmail: 'quiet@example.com',
      sendEmail: false,
    });
    expect(
      await all(kit.env.DB, "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]),
    ).toHaveLength(0);
    const other = await makeOrg(kit.fx, { name: 'Other Org' });
    await expect(
      createPassFromConnection(jobCtxOf(kit), {
        ...connectionInput(connectionId, 'ref-3'),
        orgId: other.id,
        fields: { memberName: 'x' },
        sendEmail: false,
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONNECTION_MISMATCH' });
  });
});

describe('applyConnectionRecord', () => {
  it('rejects a pass linked to another connection and does not publish unchanged data', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'ref-a'),
      fields: { memberName: 'Same' },
    });
    const base = {
      ...(await connectionSnapshot(passId, connectionId, 'ref-a')),
      cause: 'connection' as const,
    };
    expect(
      await applyConnectionRecord(jobCtxOf(kit), { ...base, fields: { memberName: 'Same' } }),
    ).toMatchObject({
      changed: false,
      pushQueued: false,
      version: 1,
      ownerUserId: null,
      linkGeneration: base.linkGeneration,
      templateId: base.templateId,
      templateVersion: base.templateVersion,
      releaseId: base.releaseId,
      credentialKeysetCommitment: base.credentialKeysetCommitment,
    });
    await expect(
      applyConnectionRecord(jobCtxOf(kit), {
        ...base,
        connectionId: await connection(),
        fields: {},
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONNECTION_MISMATCH' });
    const changed = await applyConnectionRecord(jobCtxOf(kit), {
      ...base,
      fields: { memberName: 'New' },
    });
    expect(changed).toMatchObject({
      changed: true,
      pushQueued: true,
      version: 2,
      ownerUserId: null,
      linkGeneration: base.linkGeneration,
      templateId: base.templateId,
      templateVersion: base.templateVersion,
      releaseId: base.releaseId,
      credentialKeysetCommitment: base.credentialKeysetCommitment,
    });
    const cause = await first<{ cause: string; actor_type: string }>(
      kit.env.DB,
      'SELECT cause, actor_type FROM pass_versions WHERE pass_id = ? AND version = 2',
      [passId],
    );
    expect(cause).toEqual({ cause: 'connection', actor_type: 'connection' });
  });

  it('reports a metadata-only version change without claiming an artifact push', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'meta-only'),
      fields: { memberName: 'Same' },
    });
    await run(kit.env.DB, "UPDATE passes SET field_sources = '{}' WHERE id = ?", [passId]);
    const snapshot = await connectionSnapshot(passId, connectionId, 'meta-only');
    const before = await all(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [passId],
    );
    const result = await applyConnectionRecord(jobCtxOf(kit), {
      ...snapshot,
      fields: { memberName: 'Same' },
      cause: 'connection',
    });
    expect(result).toMatchObject({
      changed: false,
      pushQueued: false,
      version: snapshot.expectedVersion + 1,
      identityId: snapshot.identityId,
      credentialGeneration: snapshot.credentialGeneration,
      templateId: snapshot.templateId,
      templateVersion: snapshot.templateVersion,
      releaseId: snapshot.releaseId,
      credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
      lifecycleGeneration: snapshot.lifecycleGeneration,
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [passId]),
    ).toEqual(before);
  });

  it('transfers credentials when the upstream holder email changes, including owned passes', async () => {
    const connectionId = await connection();
    const owner = await makeUser(kit.fx);
    const mk = async (ref: string, holderEmail: string | null = null) =>
      (
        await createPassFromConnection(jobCtxOf(kit), {
          ...connectionInput(connectionId, ref),
          fields: { memberName: 'H' },
          holderEmail,
        })
      ).passId;
    const free = await mk('h-free');
    const taken = await mk('h-taken', owner.primaryEmail);
    const freeBefore = await getPass(kit.env.DB, free);
    const takenBefore = await getPass(kit.env.DB, taken);
    if (!freeBefore || !takenBefore) throw new Error('Missing connection pass');
    expect(freeBefore).toMatchObject({ holderEmail: null, ownerUserId: null });
    expect(takenBefore).toMatchObject({ holderEmail: owner.primaryEmail, ownerUserId: owner.id });
    const base = { fields: {}, cause: 'connection' as const };
    const freeResult = await applyConnectionRecord(jobCtxOf(kit), {
      ...base,
      ...(await connectionSnapshot(free, connectionId, 'h-free')),
      holderEmail: 'new@example.com',
    });
    const takenResult = await applyConnectionRecord(jobCtxOf(kit), {
      ...base,
      ...(await connectionSnapshot(taken, connectionId, 'h-taken')),
      holderEmail: 'other@example.com',
    });
    expect(freeResult.pushQueued).toBe(true);
    expect(takenResult.pushQueued).toBe(true);
    const freeAfter = await getPass(kit.env.DB, free);
    const takenAfter = await getPass(kit.env.DB, taken);
    expect(freeAfter).toMatchObject({
      holderEmail: 'new@example.com',
      ownerUserId: null,
      credentialGeneration: freeBefore.credentialGeneration + 1,
    });
    expect(takenAfter).toMatchObject({
      holderEmail: 'other@example.com',
      ownerUserId: null,
      credentialGeneration: takenBefore.credentialGeneration + 1,
    });
    for (const [before, after] of [
      [freeBefore, freeAfter],
      [takenBefore, takenAfter],
    ] as const) {
      if (!after) throw new Error('Missing transferred connection pass');
      expect(after.version).toBe(before.version + 1);
      expect(after.linkGeneration).toBe(before.linkGeneration + 1);
      expect(after.serial).not.toBe(before.serial);
      expect(after.authToken).not.toBe(before.authToken);
      expect(after.scanCode).not.toBe(before.scanCode);
    }
    expect(
      await first(
        kit.env.DB,
        "SELECT COUNT(*) AS n FROM pass_credential_transfers WHERE pass_id IN (?, ?) AND state = 'completed'",
        [free, taken],
      ),
    ).toEqual({ n: 2 });
  });
});

describe('markPassMissing', () => {
  it('flags without changing the pass, then a good record clears the flag', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'gone'),
      fields: { memberName: 'Gone' },
    });
    const snapshot = await connectionSnapshot(passId, connectionId, 'gone');
    expect((await markPassMissing(jobCtxOf(kit), snapshot, 'flag')).pushQueued).toBe(false);
    expect(await getPass(kit.env.DB, passId)).toMatchObject({
      syncErrorCode: 'RECORD_MISSING',
      status: 'active',
      version: 1,
    });
    await applyConnectionRecord(jobCtxOf(kit), {
      ...snapshot,
      fields: { memberName: 'Gone' },
      cause: 'connection',
    });
    expect((await getPass(kit.env.DB, passId))?.syncErrorCode).toBeNull();
  });

  it('voids the pass and keeps the flag in void mode', async () => {
    const connectionId = await connection();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      ...connectionInput(connectionId, 'void-me'),
      fields: { memberName: 'V' },
    });
    const snapshot = await connectionSnapshot(passId, connectionId, 'void-me');
    expect((await markPassMissing(jobCtxOf(kit), snapshot, 'void')).pushQueued).toBe(true);
    expect(await getPass(kit.env.DB, passId)).toMatchObject({
      status: 'voided',
      syncErrorCode: 'RECORD_MISSING',
      version: 2,
    });
    // A second call does not publish again.
    expect(
      (
        await markPassMissing(
          jobCtxOf(kit),
          await connectionSnapshot(passId, connectionId, 'void-me'),
          'void',
        )
      ).pushQueued,
    ).toBe(false);
    expect((await getPass(kit.env.DB, passId))?.version).toBe(2);
  });
});
