import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import {
  createPreviewAuthorityFixture,
  type PreviewAuthorityFixture,
} from './routes-display-authority-split-fixture.ts';
import { grantScanMembership } from './test-kit.ts';

let fixture: PreviewAuthorityFixture;

beforeEach(async () => {
  fixture = await createPreviewAuthorityFixture();
});

describe('scan display preview tenant authorization', () => {
  it('stops previewing after membership revocation without recording another preview', async () => {
    const { env, f, org, own, clock, preview, previewAudits } = fixture;
    const user = await makeUser(f);
    const membershipId = await grantScanMembership(f, org.id, user.id, ['pass_operator']);
    const session = await makeSession(f, { userId: user.id });
    expect((await preview(own, session.headers)).status).toBe(200);
    await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      clock.now(),
      membershipId,
    ]);
    expect((await preview(own, session.headers)).status).toBe(404);
    expect(await previewAudits(user.id)).toEqual([{ org_id: org.id, target_id: own.passId }]);
  });

  it.each(['session', 'membership', 'replacement membership'] as const)(
    'does not return a scope if the captured %s changes during the audit write',
    async (change) => {
      const { f, org, own, clock, atPreviewAudit, preview } = fixture;
      const user = await makeUser(f);
      const membershipId = await grantScanMembership(f, org.id, user.id, ['pass_operator']);
      const session = await makeSession(f, { userId: user.id });
      await makeSession(f, { userId: user.id });
      const sessionId = await hashSessionCookie(session.cookieValue);
      const response = await atPreviewAudit(
        async (db) => {
          if (change === 'session') {
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              sessionId,
            ]);
          } else {
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              membershipId,
            ]);
            if (change === 'replacement membership')
              await grantScanMembership(f, org.id, user.id, ['pass_operator']);
          }
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('scope');
    },
  );

  // Session roles and amr are immutable (0047) and checked once at request start, so a change
  // to them mid-request is not a case: the trigger rejects the edit (authority-immutable.test.ts).
  it.each(['session idle expiry', 'disabled user', 'suspended org'] as const)(
    'does not return the captured scope when %s changes during audit',
    async (change) => {
      const { org, own, clock, memberSession, atPreviewAudit, preview } = fixture;
      const session = await memberSession(['pass_operator']);
      const sessionId = await hashSessionCookie(session.cookieValue);
      const response = await atPreviewAudit(
        async (db) => {
          if (change === 'session idle expiry')
            await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
              clock.now(),
              sessionId,
            ]);
          else if (change === 'disabled user')
            await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [session.userId]);
          else await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('Alex Morgan');
    },
  );

  it('rejects a stale resolved session after its D1 session is revoked', async () => {
    const { env, clock, own, memberSession, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    const stale = await createSessionStore(env, clock).resolve(session.cookieValue);
    if (!stale) throw new Error('Expected a persisted session');
    await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      clock.now(),
      stale.sessionId,
    ]);
    fixture.app = createApp({
      stores: { ...denyAllStores, sessions: { resolve: async () => stale } },
      clock,
    });
    const response = await preview(own, session.headers);
    expect(response.status).toBe(403);
    expect(await previewAudits(session.userId)).toEqual([]);
  });
});
