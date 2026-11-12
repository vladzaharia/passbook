import { describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { countItems, insertBroadcastStmt, insertItems, type NewBroadcast } from './repo.ts';
import { listItems } from './repo-items.ts';
import { countTarget } from './repo-target.ts';
import { startedBroadcast } from './run.ts';
import { launchBroadcast, startDueBroadcasts } from './start.ts';
import { type BroadcastKit, broadcastKit } from './test-kit.ts';

async function schedule(kit: BroadcastKit, overrides: Partial<NewBroadcast> = {}) {
  const row: NewBroadcast = {
    id: kit.fx.ids.id(),
    orgId: kit.org.id,
    mode: 'live',
    kind: 'message',
    name: 'Tenant target',
    state: 'scheduled',
    target: { templateIds: [kit.messaging.id] },
    patch: { message: 'Scheduled message' },
    notify: false,
    at: kit.clock.now() + 1_000,
    clearAfter: null,
    actor: { type: 'system', id: null },
    now: kit.clock.now(),
    ...overrides,
  };
  await insertBroadcastStmt(kit.env.DB, row).run();
  return row;
}

async function sendable(kit: BroadcastKit, id: string) {
  await run(kit.env.DB, `UPDATE broadcasts SET state = 'sending', started_at = ? WHERE id = ?`, [
    kit.clock.now(),
    id,
  ]);
}

async function versionsOf(kit: BroadcastKit, passId: string) {
  return (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
      [passId],
    )
  )?.n;
}

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBroadcast>[3];

describe('broadcast tenant targets and outcomes', () => {
  it('excludes foreign-org and foreign-mode outcomes before filtering and pagination', async () => {
    const kit = await broadcastKit();
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const a = await kit.makePass();
    const b = await kit.makePass();
    const test = await kit.makePass({ mode: 'test', holderEmail: 'test@private.example' });
    const foreign = await kit.makePass({ orgId: other.id, holderEmail: 'foreign@private.example' });
    const foreignTest = await kit.makePass({
      orgId: other.id,
      mode: 'test',
      holderEmail: 'foreign-test@private.example',
    });
    expect([test.holderEmail, foreign.holderEmail, foreignTest.holderEmail]).toEqual([
      'test@private.example',
      'foreign@private.example',
      'foreign-test@private.example',
    ]);
    const job = await schedule(kit);

    await insertItems(kit.env.DB, job.id, [
      { passId: a.id, outcome: 'updated', silent: false },
      { passId: b.id, outcome: 'updated', silent: false },
      { passId: test.id, outcome: 'failed', silent: false },
      { passId: foreign.id, outcome: 'failed', silent: false },
      { passId: foreignTest.id, outcome: 'failed', silent: false },
    ]);
    const persisted = await all<{ pass_id: string }>(
      kit.env.DB,
      'SELECT pass_id FROM broadcast_items WHERE broadcast_id = ? ORDER BY pass_id',
      [job.id],
    );
    expect(persisted.map((r) => r.pass_id)).toEqual([a.id, b.id].sort());

    // Old or corrupted rows can exist even though the current insert is fenced.
    for (const pass of [test, foreign, foreignTest]) {
      await run(kit.env.DB, `UPDATE passes SET display_title = ? WHERE id = ?`, [
        `Private ${pass.id}`,
        pass.id,
      ]);
      await run(
        kit.env.DB,
        `INSERT INTO broadcast_items (broadcast_id, pass_id, outcome, silent) VALUES (?, ?, 'failed', 0)`,
        [job.id, pass.id],
      );
    }
    const page1 = await listItems(kit.env.DB, job.id, job.orgId, job.mode, { limit: 1 });
    expect(page1.rows.map((r) => r.pass_id)).toEqual([[a.id, b.id].sort()[0]]);
    expect(page1.nextCursor).toBe(page1.rows[0]?.pass_id);
    const page2 = await listItems(kit.env.DB, job.id, job.orgId, job.mode, {
      limit: 1,
      cursor: page1.nextCursor ?? '',
    });
    expect(page2.rows.map((r) => r.pass_id)).toEqual([[a.id, b.id].sort()[1]]);
    expect(page2.nextCursor).toBeNull();
    expect(
      (await listItems(kit.env.DB, job.id, job.orgId, job.mode, { limit: 100, outcome: 'failed' }))
        .rows,
    ).toEqual([]);
    expect(
      (await listItems(kit.env.DB, 'missing-broadcast', job.orgId, job.mode, { limit: 100 })).rows,
    ).toEqual([]);
    expect((await listItems(kit.env.DB, job.id, other.id, job.mode, { limit: 100 })).rows).toEqual(
      [],
    );
    expect((await listItems(kit.env.DB, job.id, job.orgId, 'test', { limit: 100 })).rows).toEqual(
      [],
    );
    expect(await countItems(kit.env.DB, [job.id], other.id, job.mode)).toEqual([]);
    expect(await countItems(kit.env.DB, [job.id], job.orgId, 'test')).toEqual([]);
    expect(await countItems(kit.env.DB, [job.id], job.orgId, job.mode)).toMatchObject([
      { broadcast_id: job.id, outcome: 'updated', n: 2 },
    ]);
  });

  it('uses the broadcast org and mode even when the saved target contains conflicting values', async () => {
    const kit = await broadcastKit();
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const own = await kit.makePass();
    const test = await kit.makePass({ mode: 'test' });
    const foreign = await kit.makePass({ orgId: other.id });
    const foreignTest = await kit.makePass({ orgId: other.id, mode: 'test' });
    const job = await schedule(kit, {
      target: { templateIds: [kit.messaging.id], orgId: other.id, mode: 'test' },
    });
    await sendable(kit, job.id);
    await applyChunk(jobCtxOf(kit), job.id, null);

    expect((await getPass(kit.env.DB, own.id))?.personalization.message).toBe('Scheduled message');
    for (const pass of [test, foreign, foreignTest]) {
      expect((await getPass(kit.env.DB, pass.id))?.personalization.message).toBeUndefined();
      expect(await versionsOf(kit, pass.id)).toBe(1);
    }
    expect(
      (await listItems(kit.env.DB, job.id, job.orgId, job.mode, { limit: 100 })).rows.map(
        (r) => r.pass_id,
      ),
    ).toEqual([own.id]);
  });

  it('counts only same-org and same-mode notification events in the budget preview', async () => {
    const kit = await broadcastKit();
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const wrongOrg = await kit.makePass();
    const wrongMode = await kit.makePass();
    const genuine = await kit.makePass();
    const now = kit.clock.now();
    const addEvent = async (passId: string, orgId: string, mode: 'live' | 'test') => {
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
         VALUES (?, ?, ?, ?, 'pass.updated', '{"notified":true}', ?)`,
        [kit.fx.ids.id(), orgId, passId, mode, now],
      );
    };
    for (let i = 0; i < 2; i++) {
      await addEvent(wrongOrg.id, other.id, 'live');
      await addEvent(wrongMode.id, kit.org.id, 'test');
      await addEvent(genuine.id, kit.org.id, 'live');
    }
    const filter = {
      orgId: kit.org.id,
      mode: 'live' as const,
      templateIds: [kit.messaging.id],
      limit: 100,
    };
    expect(await countTarget(kit.env.DB, filter, now, now - 1_000, 2)).toMatchObject({
      targeted: 3,
      overBudget: 1,
    });
    for (const pass of [wrongOrg, wrongMode]) {
      await addEvent(pass.id, kit.org.id, 'live');
      await addEvent(pass.id, kit.org.id, 'live');
    }
    expect(await countTarget(kit.env.DB, filter, now, now - 1_000, 2)).toMatchObject({
      targeted: 3,
      overBudget: 3,
    });
  });

  it('fails closed instead of treating an invalid empty template target as all templates', async () => {
    const kit = await broadcastKit();
    const pass = await kit.makePass();
    const job = await schedule(kit, { target: { templateIds: [] } });
    await sendable(kit, job.id);
    await expect(applyChunk(jobCtxOf(kit), job.id, null)).rejects.toThrow();
    expect((await getPass(kit.env.DB, pass.id))?.personalization.message).toBeUndefined();
    expect(await versionsOf(kit, pass.id)).toBe(1);
    expect((await listItems(kit.env.DB, job.id, job.orgId, job.mode, { limit: 100 })).rows).toEqual(
      [],
    );
  });

  it.each(['org', 'mode'] as const)(
    'rejects an unreserved %s change after selection and preserves tenant isolation',
    async (changed) => {
      const kit = await broadcastKit();
      const other = await makeOrg(kit.fx, { name: 'Moved tenant' });
      const pass = await kit.makePass();
      const foreign = await kit.makePass({ orgId: other.id });
      const wrongMode = await kit.makePass({ mode: 'test' });
      const job = await schedule(kit);
      await sendable(kit, job.id);
      const original = kit.registry.resolve.bind(kit.registry);
      let moved = false;
      kit.registry.resolve = async (id, version) => {
        if (!moved) {
          moved = true;
          await expect(
            run(
              kit.env.DB,
              changed === 'org'
                ? 'UPDATE passes SET org_id = ? WHERE id = ?'
                : 'UPDATE passes SET mode = ? WHERE id = ?',
              [changed === 'org' ? other.id : 'test', pass.id],
            ),
          ).rejects.toThrow('credential transfer required');
        }
        return original(id, version);
      };
      try {
        await applyChunk(jobCtxOf(kit), job.id, null);
      } finally {
        kit.registry.resolve = original;
      }
      expect(moved).toBe(true);
      expect((await getPass(kit.env.DB, pass.id))?.personalization.message).toBe(
        'Scheduled message',
      );
      expect(await versionsOf(kit, pass.id)).toBe(2);
      for (const excluded of [foreign, wrongMode]) {
        expect((await getPass(kit.env.DB, excluded.id))?.personalization.message).toBeUndefined();
        expect(await versionsOf(kit, excluded.id)).toBe(1);
      }
      expect(
        (
          await all<{ pass_id: string }>(
            kit.env.DB,
            'SELECT pass_id FROM broadcast_items WHERE broadcast_id = ?',
            [job.id],
          )
        ).map((item) => item.pass_id),
      ).toEqual([pass.id]);
    },
  );
});

describe('scheduled broadcast execution', () => {
  it('runs the persisted tenant snapshot after session removal, including partial retries', async () => {
    const kit = await broadcastKit();
    const other = await makeOrg(kit.fx, { name: 'Other tenant' });
    const user = await makeUser(kit.fx);
    await makeSession(kit.fx, { userId: user.id });
    const invitationId = kit.fx.ids.id();
    const membershipId = kit.fx.ids.id();
    const roles = JSON.stringify(['pass_operator']);
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invitationId,
        kit.org.id,
        user.primaryEmail,
        roles,
        kit.fx.ids.token(),
        now,
        now + 60_000,
        now,
      ],
    );
    await run(
      kit.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [membershipId, kit.org.id, user.id, invitationId, roles, now],
    );
    const a = await kit.makePass();
    const b = await kit.makePass();
    const test = await kit.makePass({ mode: 'test' });
    const foreign = await kit.makePass({ orgId: other.id });
    const differentTemplate = await kit.makePass({ templateId: kit.plain.id });
    const job = await schedule(kit, { actor: { type: 'user', id: user.id } });
    await run(kit.env.DB, 'DELETE FROM sessions WHERE user_id = ?', [user.id]);
    kit.clock.advance(2_000);

    await startDueBroadcasts(jobCtxOf(kit));
    await startDueBroadcasts(jobCtxOf(kit));
    const instanceId = `broadcast-${job.id}`;
    expect(kit.broadcast.created.filter((item) => item.id === instanceId)).toHaveLength(1);
    const stored = await first<{ org_id: string; mode: string; target: string; state: string }>(
      kit.env.DB,
      'SELECT org_id, mode, target, state FROM broadcasts WHERE id = ?',
      [job.id],
    );
    expect(stored).toMatchObject({ org_id: kit.org.id, mode: 'live', state: 'sending' });
    expect(JSON.parse(stored?.target ?? '{}')).toEqual(job.target);
    expect(await startedBroadcast(jobCtxOf(kit), instanceId, job.id)).toBe(true);
    await applyChunk(jobCtxOf(kit), job.id, null);
    await applyChunk(jobCtxOf(kit), job.id, null);
    expect(await versionsOf(kit, a.id)).toBe(2);
    expect(await versionsOf(kit, b.id)).toBe(2);

    // A crash after publication but before recording its item is recognized on retry.
    await run(kit.env.DB, 'DELETE FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?', [
      job.id,
      a.id,
    ]);
    await applyChunk(jobCtxOf(kit), job.id, null);
    expect(await versionsOf(kit, a.id)).toBe(2);
    expect(
      await first(
        kit.env.DB,
        'SELECT outcome FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?',
        [job.id, a.id],
      ),
    ).toEqual({ outcome: 'updated' });
    expect((await runBroadcast(kit.env, instanceId, { broadcastId: job.id }, step)).state).toBe(
      'sent',
    );
    for (const pass of [test, foreign, differentTemplate]) {
      expect((await getPass(kit.env.DB, pass.id))?.personalization.message).toBeUndefined();
      expect(await versionsOf(kit, pass.id)).toBe(1);
    }
    expect(await countItems(kit.env.DB, [job.id], job.orgId, job.mode)).toMatchObject([
      { broadcast_id: job.id, outcome: 'updated', n: 2 },
    ]);
  });

  it('launches only while the creator holds messages:manage in the org', async () => {
    const kit = await broadcastKit();
    const join = async (role: string, org = kit.org.id) => {
      const user = await makeUser(kit.fx);
      const invitationId = kit.fx.ids.id();
      const membershipId = kit.fx.ids.id();
      const roles = JSON.stringify([role]);
      const now = kit.clock.now();
      await run(
        kit.env.DB,
        `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [invitationId, org, user.primaryEmail, roles, kit.fx.ids.token(), now, now + 60_000, now],
      );
      await run(
        kit.env.DB,
        `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [membershipId, org, user.id, invitationId, roles, now],
      );
      return { user, membershipId };
    };
    const other = await makeOrg(kit.fx, { name: 'Creator elsewhere' });
    const active = await join('pass_operator');
    const removed = await join('pass_operator');
    const readOnly = await join('read_only');
    const foreign = await join('org_admin', other.id);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      removed.membershipId,
    ]);
    const jobs = [];
    for (const who of [active, removed, readOnly, foreign]) {
      jobs.push(await schedule(kit, { actor: { type: 'user', id: who.user.id } }));
    }
    kit.clock.advance(2_000);
    const launched = [];
    for (const job of jobs)
      launched.push(await launchBroadcast(jobCtxOf(kit), { id: job.id, org_id: job.orgId }));
    expect(launched).toEqual([true, false, false, false]);
    for (const job of jobs.slice(1)) {
      expect(
        await first(kit.env.DB, 'SELECT state, error_code FROM broadcasts WHERE id = ?', [job.id]),
      ).toEqual({ state: 'failed', error_code: 'CREATOR_REVOKED' });
    }
    expect(kit.broadcast.created.map((item) => item.id)).toEqual([`broadcast-${jobs[0]?.id}`]);
  });

  it('records the stored org even when the launcher was passed a stale org', async () => {
    const kit = await broadcastKit();
    const other = await makeOrg(kit.fx, { name: 'Wrong launcher tenant' });
    const job = await schedule(kit);
    expect(await launchBroadcast(jobCtxOf(kit), { id: job.id, org_id: other.id })).toBe(true);
    expect(
      await first(kit.env.DB, 'SELECT org_id, target_id FROM workflow_runs WHERE instance_id = ?', [
        `broadcast-${job.id}`,
      ]),
    ).toEqual({ org_id: kit.org.id, target_id: job.id });
  });

  it('still blocks suspended organizations and disabled or revoked creators', async () => {
    const kit = await broadcastKit();
    const user = await makeUser(kit.fx);
    const revoked = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['messages:write'] });
    const expired = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['messages:write'] });
    // Key identity columns are immutable, so the expiry is set by replacing the row.
    await run(
      kit.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at, expires_at)
       SELECT ?, org_id, name, ?, key_hash || 'x', scopes, created_at, ? FROM api_keys WHERE id = ?`,
      [`${expired.id}-e`, kit.fx.ids.token(6), kit.clock.now() - 1, expired.id],
    );
    const suspended = await makeOrg(kit.fx, { name: 'Suspended tenant' });
    const jobs = [
      await schedule(kit, { actor: { type: 'user', id: user.id } }),
      await schedule(kit, { actor: { type: 'api_key', id: revoked.id } }),
      await schedule(kit, { actor: { type: 'api_key', id: `${expired.id}-e` } }),
      await schedule(kit, { orgId: suspended.id }),
    ];
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      revoked.id,
    ]);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [suspended.id]);
    for (const [index, job] of jobs.entries()) {
      expect(await launchBroadcast(jobCtxOf(kit), { id: job.id, org_id: job.orgId })).toBe(false);
      expect(
        await first(kit.env.DB, 'SELECT state, error_code FROM broadcasts WHERE id = ?', [job.id]),
        // A disabled user and a suspended org are cancelled by their triggers; a revoked or expired key
        // has no trigger and fails at launch.
      ).toEqual({
        state: index === 0 || index === 3 ? 'cancelled' : 'failed',
        error_code: index === 3 ? 'ORG_INACTIVE' : 'CREATOR_REVOKED',
      });
    }
    expect(kit.broadcast.created).toEqual([]);
  });
});
