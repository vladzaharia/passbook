import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
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
  it('projects the pass when nothing changes at the post-audit output read', async () => {
    const { f, org, own, atPreviewOutputFence, preview } = fixture;
    const user = await makeUser(f);
    await grantScanMembership(f, org.id, user.id, ['pass_operator']);
    const session = await makeSession(f, { userId: user.id });
    const response = await atPreviewOutputFence(
      async () => {},
      () => preview(own, session.headers),
    );
    expect(response.status).toBe(200);
  });

  it.each(['membership', 'session', 'pass', 'Wallet', 'source', 'credential', 'transfer'] as const)(
    'handles a %s change at the post-audit output read',
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
      const content = change === 'Wallet' || change === 'source';
      expect(response.status).toBe(
        change === 'membership' || change === 'session' ? 403 : content ? 200 : 404,
      );
      const body = await response.text();
      // Wallet and source edits are content, not authority (F8): the scope is still served.
      if (content) expect(body).toContain('scope');
      else {
        expect(body).not.toContain('scope');
        expect(body).not.toContain('Alex Morgan');
      }
      expect(await previewAudits(user.id)).toEqual([{ org_id: org.id, target_id: own.passId }]);
    },
  );
});
