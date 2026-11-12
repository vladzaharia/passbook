import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import {
  createPreviewAuthorityFixture,
  type PreviewAuthorityFixture,
} from './routes-display-authority-split-fixture.ts';
import { grantScanMembership, startScanCredentialTransfer } from './test-kit.ts';

let fixture: PreviewAuthorityFixture;

beforeEach(async () => {
  fixture = await createPreviewAuthorityFixture();
});

describe('scan display preview tenant authorization', () => {
  it.each(['membership', 'session', 'pass', 'Wallet', 'source', 'credential', 'transfer'] as const)(
    'does not project a pass when %s changes at the post-audit output read',
    async (change) => {
      const {
        f,
        org,
        own,
        clock,
        ownReleaseFixture,
        atPreviewOutputFence,
        startTransfer,
        preview,
        previewAudits,
      } = fixture;
      const user = await makeUser(f);
      const membershipId = await grantScanMembership(f, org.id, user.id, ['pass_operator']);
      const session = await makeSession(f, { userId: user.id });
      const sessionId = await hashSessionCookie(session.cookieValue);
      const response = await atPreviewOutputFence(
        async (db) => {
          if (change === 'membership') {
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              membershipId,
            ]);
          } else if (change === 'session') {
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              sessionId,
            ]);
          } else if (change === 'pass') {
            await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
              clock.now(),
              own.passId,
            ]);
          } else if (change === 'Wallet') {
            await run(
              db,
              "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.organizationName', 'Changed') WHERE pass_id = ?",
              [own.passId],
            );
          } else if (change === 'source') {
            await run(
              db,
              'UPDATE passes SET field_sources = \'{"memberName":"connection"}\' WHERE id = ?',
              [own.passId],
            );
          } else if (change === 'credential') {
            await startScanCredentialTransfer(ownReleaseFixture, own.passId, { db });
          } else {
            await startTransfer(db, own.passId);
          }
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(change === 'membership' || change === 'session' ? 403 : 404);
      const body = await response.text();
      expect(body).not.toContain('scope');
      expect(body).not.toContain('Alex Morgan');
      expect(await previewAudits(user.id)).toEqual([{ org_id: org.id, target_id: own.passId }]);
    },
  );

  it('fences a changed session CSRF secret as a scalar in the final output batch', async () => {
    const { env, f, org, own, memberSession, atPreviewOutputFence, preview, previewAudits } =
      fixture;
    const session = await memberSession(['pass_operator']);
    const sessionId = await hashSessionCookie(session.cookieValue);
    const replacement = f.ids.token();
    const trigger = await first<{ sql: string }>(
      env.DB,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_csrf_secret_immutable'",
    );
    if (!trigger?.sql) throw new Error('Missing session CSRF immutability trigger');
    await expect(
      run(env.DB, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', [
        replacement,
        sessionId,
      ]),
    ).rejects.toThrow('session csrf secret is immutable');
    await run(env.DB, 'DROP TRIGGER sessions_csrf_secret_immutable');
    try {
      let packedReads = 0;
      let scalarReads = 0;
      const response = await atPreviewOutputFence(
        async (db) => {
          await run(db, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', [
            replacement,
            sessionId,
          ]);
        },
        () => preview(own, session.headers),
        (sql, values) => {
          if (sql.includes('AS csrf_authorized')) {
            scalarReads++;
            expect(sql).toContain('scan-ephemeral-csrf');
            expect(values).toContain(session.csrf);
          } else {
            packedReads++;
            expect(JSON.stringify(values)).not.toContain(session.csrf);
          }
        },
      );
      expect(packedReads).toBeGreaterThanOrEqual(2);
      expect(scalarReads).toBeGreaterThanOrEqual(2);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const text = await response.text();
      for (const secret of ['scope', 'Alex Morgan', session.csrf, replacement])
        expect(text).not.toContain(secret);
      expect(await previewAudits(session.userId)).toEqual([
        { org_id: org.id, target_id: own.passId },
      ]);
    } finally {
      try {
        await run(env.DB, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', [
          session.csrf,
          sessionId,
        ]);
      } finally {
        await run(env.DB, trigger.sql);
      }
    }
  });
});
