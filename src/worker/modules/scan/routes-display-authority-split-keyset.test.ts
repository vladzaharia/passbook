import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
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
  it.each(['session', 'membership'] as const)(
    'does not bootstrap credential authority when the captured %s is revoked',
    async (change) => {
      const { env, f, org, own, clock, atPreviewKeysetBootstrap, preview, previewAudits } = fixture;
      const user = await makeUser(f);
      const membershipId = await grantScanMembership(f, org.id, user.id, ['pass_operator']);
      const session = await makeSession(f, { userId: user.id });
      const sessionId = await hashSessionCookie(session.cookieValue);
      expect(
        await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toBeNull();
      const response = await atPreviewKeysetBootstrap(
        async (db) => {
          if (change === 'session')
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              sessionId,
            ]);
          else
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              membershipId,
            ]);
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('Alex Morgan');
      expect(
        await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toBeNull();
      expect(await previewAudits(user.id)).toEqual([]);
    },
  );

  it('keeps the request key snapshot if the configured KEK changes at its first tenant read', async () => {
    const { env, org, own, memberSession, atPreviewRead, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    const originalKey = env.KEK_V1;
    const alternate = btoa('z'.repeat(32));
    const wrongKey = originalKey === alternate ? btoa('y'.repeat(32)) : alternate;
    const originalCommitment = await credentialRefKeysetCommitment(env);
    try {
      const response = await atPreviewRead(
        (sql) => sql.includes('FROM org_memberships m') && sql.includes('o.name AS org_name'),
        async () => {
          Object.assign(env, { KEK_V1: wrongKey });
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('Alex Morgan');
      expect(
        await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toEqual({ commitment: originalCommitment });
      expect(text).not.toContain(wrongKey);
      const next = await preview(own, session.headers);
      expect(next.status).toBe(503);
      const problem = await next.text();
      expect(JSON.parse(problem)).toMatchObject({
        status: 503,
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(problem).not.toContain('Alex Morgan');
      expect(await previewAudits(session.userId)).toEqual([
        { org_id: org.id, target_id: own.passId },
      ]);
    } finally {
      Object.assign(env, { KEK_V1: originalKey });
    }
  });

  it('fails closed without auditing when the configured credential keyset differs', async () => {
    const { env, own, memberSession, preview, previewAudits } = fixture;
    const session = await memberSession(['pass_operator']);
    const commitment = await ensureCredentialRefKeyset(env.DB, env);
    const alternate = btoa('z'.repeat(32));
    const wrongKey = env.KEK_V1 === alternate ? btoa('y'.repeat(32)) : alternate;
    const response = await preview(own, session.headers, {}, { ...env, KEK_V1: wrongKey });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      status: 503,
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    for (const secret of ['scope', 'Alex Morgan', commitment]) expect(text).not.toContain(secret);
    expect(await previewAudits(session.userId)).toEqual([]);
    expect((await preview(own, session.headers)).status).toBe(200);
  });

  it('rejects a keyset changed between its capture and the candidate read', async () => {
    const { own, memberSession, withMutableKeyset, atPreviewRead, preview, previewAudits } =
      fixture;
    const session = await memberSession(['pass_operator']);
    await withMutableKeyset(async (original, replacement) => {
      const response = await atPreviewRead(
        (sql) => sql.includes('snapshot.pass_json AS pass_json') && sql.includes('p.id = ?'),
        async (real) => {
          await run(real, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
            replacement,
          ]);
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        status: 503,
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      for (const secret of ['scope', 'Alex Morgan', original, replacement])
        expect(text).not.toContain(secret);
      expect(await previewAudits(session.userId)).toEqual([]);
    });
  });

  it('fences the captured keyset at the final post-audit output read', async () => {
    const {
      org,
      own,
      memberSession,
      withMutableKeyset,
      atPreviewOutputFence,
      preview,
      previewAudits,
    } = fixture;
    const session = await memberSession(['pass_operator']);
    await withMutableKeyset(async (original, replacement) => {
      const response = await atPreviewOutputFence(
        async (real) => {
          await run(real, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
            replacement,
          ]);
        },
        () => preview(own, session.headers),
      );
      expect(response.status).toBe(404);
      const text = await response.text();
      for (const secret of ['scope', 'Alex Morgan', original, replacement])
        expect(text).not.toContain(secret);
      expect(await previewAudits(session.userId)).toEqual([
        { org_id: org.id, target_id: own.passId },
      ]);
    });
  });
});
