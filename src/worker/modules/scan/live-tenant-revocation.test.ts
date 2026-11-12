import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, runOne } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantScanRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { liveAttachment } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { liveTenantFixture } from './live-tenant-test-fixtures.ts';
import { insertSession, storedSession } from './repo-live-tenant-db-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { grantScanMembership, proofedScanActor, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, refreshedAttachment, attachmentForSession, assertClosed, hub } = fixture;
let kit: ScanKit;
beforeAll(async () => {
  ({ kit } = await fixture.setup());
});

describe('live tenant and workspace revocation', () => {
  it('rejects role replacement and same-role revoke/regrant ABA, but accepts a fresh snapshot', async () => {
    const screen = await managedScreen();
    expect((await liveRecipient(kit.ctx, screen.attachment))?.actor.role).toBe('manager');
    expect(
      (
        await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          screen.membershipId,
        ])
      ).changes,
    ).toBe(1);
    await assertClosed(screen.attachment);
    const readerId = await grantScanMembership(kit.fx, kit.org.id, screen.user.id, ['read_only']);
    expect(readerId).not.toBe(screen.membershipId);
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    const reader = await refreshedAttachment(screen);
    expect((await liveRecipient(kit.ctx, reader))?.actor.role).toBe('door');
    expect(
      (
        await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          readerId,
        ])
      ).changes,
    ).toBe(1);
    const replacementId = await grantScanMembership(kit.fx, kit.org.id, screen.user.id);
    expect(replacementId).not.toBe(screen.membershipId);
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    expect(await liveRecipient(kit.ctx, reader)).toBeNull();
    const fresh = await refreshedAttachment(screen);
    const recipient = await liveRecipient(kit.ctx, fresh);
    expect(
      recipient?.actor.role === 'manager' &&
        recipient.actor.platformSessionId === screen.resolved.sessionId &&
        recipient.actor.tenantAuthority?.membershipId === replacementId &&
        recipient.actor.tenantAuthority.capability === 'scanning:read',
    ).toBe(true);
  });

  it('prevents session-secret replacement and deleted-ID ABA while admitting a new session', async () => {
    const screen = await managedScreen();
    const original = await storedSession(kit, screen.resolved.sessionId);
    const second = await makeSession(kit.fx, { userId: screen.user.id, roles: ['admin', 'user'] });
    const resolved = await createSessionStore(kit.env, kit.clock).resolve(second.cookieValue);
    if (!resolved) throw new Error('Missing replacement platform session.');
    const replacement = await attachmentForSession(screen, resolved);
    const replacementRow = await storedSession(kit, resolved.sessionId);
    expect(await liveRecipient(kit.ctx, replacement)).not.toBeNull();
    for (const [column, value] of [
      ['csrf_secret', second.csrf],
      ['created_at', original.created_at + 1],
      ['expires_at', original.expires_at + 1],
    ] as const) {
      await expect(
        run(kit.env.DB, `UPDATE sessions SET ${column}=? WHERE id_hash=?`, [
          value,
          original.id_hash,
        ]),
      ).rejects.toThrow();
    }
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await runOne(kit.env.DB, 'DELETE FROM sessions WHERE id_hash=?', [original.id_hash]);
    await expect(insertSession(kit, original, second.csrf)).rejects.toThrow();
    await expect(insertSession(kit, original, screen.session.csrf)).rejects.toThrow();
    await assertClosed(screen.attachment);
    await runOne(kit.env.DB, 'DELETE FROM sessions WHERE id_hash=?', [replacementRow.id_hash]);
    await expect(insertSession(kit, replacementRow, screen.session.csrf)).rejects.toThrow();
    await assertClosed(replacement);
    const freshSession = await makeSession(kit.fx, {
      userId: screen.user.id,
      roles: ['admin', 'user'],
    });
    const freshAuth = await createSessionStore(kit.env, kit.clock).resolve(
      freshSession.cookieValue,
    );
    if (!freshAuth) throw new Error('Missing fresh platform session.');
    const fresh = await attachmentForSession(screen, freshAuth);
    expect(await liveRecipient(kit.ctx, fresh)).not.toBeNull();
  });

  // Platform session roles are immutable (0047), so a role change is not a case.
  it.each(['revoked', 'idle expiry', 'user disabled'] as const)(
    'rejects a previously valid attachment after %s',
    async (change) => {
      const screen = await managedScreen();
      expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
      if (change === 'revoked') {
        expect(await revokeSession(kit.env.DB, screen.resolved.sessionId, kit.clock.now())).toBe(
          true,
        );
      } else if (change === 'user disabled') {
        await run(kit.env.DB, "UPDATE users SET status='disabled' WHERE id=?", [screen.user.id]);
      } else {
        await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at=? WHERE id_hash=?', [
          kit.clock.now(),
          screen.resolved.sessionId,
        ]);
      }
      await assertClosed(screen.attachment);
    },
  );

  it('checks absolute expiry independently of the idle and attachment deadlines', async () => {
    const screen = await managedScreen();
    const stored = await first<{ expires_at: number }>(
      kit.env.DB,
      'SELECT expires_at FROM sessions WHERE id_hash=?',
      [screen.resolved.sessionId],
    );
    if (!stored) throw new Error('Missing platform session.');
    await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at=? WHERE id_hash=?', [
      stored.expires_at + 1,
      screen.resolved.sessionId,
    ]);
    // The idle limit is beyond the absolute deadline; the attachment may not outlive that deadline.
    const attachment = { ...screen.attachment, expiresAt: stored.expires_at };
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    expect(
      await liveRecipient(kit.ctx, { ...attachment, expiresAt: stored.expires_at + 1 }),
    ).toBeNull();
    const expired = { ...kit.ctx, clock: { now: () => stored.expires_at } };
    expect(await liveRecipient(expired, attachment)).toBeNull();
  });

  it('rejects suspension and the old revision after reactivation, but permits a fresh authority', async () => {
    const screen = await managedScreen();
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    try {
      await run(
        kit.env.DB,
        "UPDATE orgs SET status='suspended', updated_at=updated_at+1 WHERE id=?",
        [kit.org.id],
      );
      await assertClosed(screen.attachment);
      await run(kit.env.DB, "UPDATE orgs SET status='active', updated_at=updated_at+1 WHERE id=?", [
        kit.org.id,
      ]);
      expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
      const fresh = await refreshedAttachment(screen);
      expect(await liveRecipient(kit.ctx, fresh)).not.toBeNull();
      // updated_at is a timestamp, not an epoch: touching it does not close a fresh screen.
      await run(kit.env.DB, 'UPDATE orgs SET updated_at=updated_at+1 WHERE id=?', [kit.org.id]);
      expect(await liveRecipient(kit.ctx, fresh)).not.toBeNull();
    } finally {
      await run(
        kit.env.DB,
        "UPDATE orgs SET status='active', updated_at=updated_at+1 WHERE id=? AND status!='active'",
        [kit.org.id],
      );
    }
  });

  it.each(['scanner revoked', 'workspace paused', 'workspace scope invalid'] as const)(
    'rejects an attachment when its %s',
    async (change) => {
      const screen = await managedScreen();
      expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
      if (change === 'scanner revoked') {
        await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          screen.device.id,
        ]);
      } else if (change === 'workspace paused') {
        await run(
          kit.env.DB,
          "UPDATE scanning_sessions SET status='paused', updated_at=updated_at+1 WHERE id=?",
          [screen.workspace.id],
        );
      } else {
        await run(
          kit.env.DB,
          "UPDATE scanning_sessions SET accepts='{}', updated_at=updated_at+1 WHERE id=?",
          [screen.workspace.id],
        );
      }
      // A removed device is lost access; a paused or rescoped workspace is drift to reconnect after.
      await assertClosed(screen.attachment, change === 'scanner revoked' ? 'access' : 'drift');
    },
  );

  it('keeps an attachment open when only a scanner label or timestamp changes', async () => {
    const screen = await managedScreen();
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await run(
      kit.env.DB,
      "UPDATE scanners SET updated_at=updated_at+1, name=name || ' (renamed)' WHERE id=?",
      [screen.device.id],
    );
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
  });

  it('rejects missing or forged workspace bindings', async () => {
    const screen = await managedScreen();
    const session = screen.attachment.session;
    if (!session) throw new Error('Missing workspace binding.');
    const missing = { ...screen.attachment };
    Reflect.deleteProperty(missing, 'session');
    for (const attachment of [
      missing,
      { ...screen.attachment, session: null },
      { ...screen.attachment, session: { ...session, id: 'another-session' } },
      { ...screen.attachment, session: { ...session, status: 'paused' as const } },
      { ...screen.attachment, session: { ...session, updatedAt: session.updatedAt + 1 } },
    ]) {
      expect((await liveRecipient(kit.ctx, attachment)) === null).toBe(true);
      expect(JSON.stringify(await hub().snapshot(attachment)) === '{"rows":[],"cursor":null}').toBe(
        true,
      );
    }
  });

  it('rejects missing or altered observations of the originally bound workspace', async () => {
    const screen = await managedScreen();
    const missing = liveAttachment(kit.ctx, screen.actor);
    Reflect.deleteProperty(missing, 'observation');
    const noActor = liveAttachment(kit.ctx, screen.actor);
    Reflect.deleteProperty(noActor, 'actor');
    const empty = liveAttachment(kit.ctx, screen.actor);
    const changed = liveAttachment(kit.ctx, screen.actor);
    if (!changed.observation) throw new Error('Missing original workspace observation.');
    const altered = {
      ...changed,
      observation: {
        ...changed.observation,
        parent: {
          ...changed.observation.parent,
          updated_at: changed.observation.parent.updated_at + 1,
        },
      },
    };
    for (const attachment of [missing, noActor, { ...empty, observation: null }, altered]) {
      expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
      expect(await hub().snapshot(attachment)).toEqual({ rows: [], cursor: null });
    }
  });

  it('invalidates the old workspace binding after pause and resume ABA', async () => {
    const screen = await managedScreen();
    const original = screen.attachment.session;
    if (!original) throw new Error('Missing workspace binding.');
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status='paused', updated_at=updated_at+1 WHERE id=?",
      [screen.workspace.id],
    );
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status='active', updated_at=updated_at+1 WHERE id=?",
      [screen.workspace.id],
    );
    await assertClosed(screen.attachment, 'drift');
    const actor = await managedAdminActor(
      kit.ctx,
      screen.resolved,
      'live',
      kit.org.id,
      screen.device.id,
    );
    actor.platformSessionId = screen.resolved.sessionId;
    actor.tenantAuthority = screen.authority;
    actor.role = tenantScanRole(screen.authority);
    await bindScanningSession(kit.ctx, actor);
    const fresh = liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor));
    expect(fresh.session).toMatchObject({
      id: original.id,
      status: 'active',
      updatedAt: original.updatedAt + 2,
    });
    expect(await liveRecipient(kit.ctx, fresh)).not.toBeNull();
  });

  it('rejects a screen when its release-backed template becomes unavailable', async () => {
    const screen = await managedScreen({ scoped: true });
    if (!screen.templateId) throw new Error('Missing scoped template.');
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await run(
      kit.env.DB,
      "UPDATE templates SET status='deleted', updated_at=updated_at+1 WHERE id=?",
      [screen.templateId],
    );
    await assertClosed(screen.attachment, 'drift');
  });
});
