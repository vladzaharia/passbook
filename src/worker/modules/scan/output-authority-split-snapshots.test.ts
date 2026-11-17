import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import {
  fixture,
  kit,
  noDisclosure,
  raceFence,
  templateId,
} from './repo-output-authority-split-test-fixtures.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { grantScanMembership, key } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

describe('atomic scanner response authority', () => {
  it.each(['membership', 'session'] as const)(
    'masks a ready card when the original tenant %s is revoked after projection',
    async (change) => {
      const f = await fixture();
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
      const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
      if (!auth) throw new Error('Missing session.');
      const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
      if (authority.kind !== 'session') throw new Error('Missing tenant authority.');
      const actor = adminActor(auth, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [templateId],
        timeZone: 'UTC',
      });
      actor.platformSessionId = auth.sessionId;
      actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
      actor.role = tenantScanRole(authority);
      await captureTestEpochs(kit.ctx, actor);
      const real = kit.env.DB;
      const race = raceFence(real, () =>
        change === 'membership'
          ? run(real, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
              kit.clock.now(),
              membershipId,
            ])
          : run(real, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
              kit.clock.now(),
              auth.sessionId,
            ]),
      );
      Object.assign(kit.env, { DB: race.db });
      try {
        const result = await resolveOutcome(kit.ctx, actor, {
          idempotencyKey: key(),
          input: { passId: f.pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
        });
        expect(race.fired()).toBe(true);
        expect(result.outcome).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          card: null,
          display: null,
        });
        noDisclosure(JSON.stringify(result), f.pass.id);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );
});
