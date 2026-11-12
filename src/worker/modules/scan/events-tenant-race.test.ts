import { beforeEach, describe, expect, it } from 'vitest';
import { pageOf, ScanEventSchema } from '../../../shared/contracts/index.ts';
import { run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';

const race = createEventTenantRace();
let { clock, orgId, eventId, member, membershipId } = race;
beforeEach(() => {
  ({ clock, orgId, eventId, member, membershipId } = race);
});
const { atEventRead, call, state, withMutableKeyset } = race;

describe('event read authority', () => {
  for (const [kind, phase] of [
    ['detail', 'row'],
    ['detail', 'cache'],
    ['list', 'row'],
    ['list', 'cache'],
  ] as const) {
    it.each(['membership', 'session'] as const)(
      `revalidates ${kind} when %s changes at ${phase}`,
      async (changed) => {
        const before = await state();
        const sessionHash = await hashSessionCookie(member.cookieValue);
        const response = await atEventRead(
          kind,
          phase,
          async (db) => {
            if (changed === 'membership') {
              await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                clock.now(),
                membershipId,
              ]);
            } else if (changed === 'session') {
              await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                clock.now(),
                sessionHash,
              ]);
            }
          },
          () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}`),
        );
        if (kind === 'detail') {
          expect(response.status).toBe(403);
        } else {
          expect(response.status).toBe(200);
          expect(pageOf(ScanEventSchema).parse(await response.json())).toEqual({
            items: [],
            nextCursor: null,
          });
        }
        expect(await state()).toEqual(before);
      },
    );
  }

  // Session roles and the CSRF secret are fixed at sign-in (0047): the edit is refused, nothing can
  // change under the read, and it succeeds.
  for (const kind of ['detail', 'list'] as const)
    for (const phase of ['row', 'cache'] as const)
      it.each([
        ['session roles', 'UPDATE sessions SET roles = ? WHERE id_hash = ?', '["admin","user"]'],
        ['session csrf', 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', 'replacement'],
      ] as const)(
        `reads ${kind} at ${phase} when a %s edit is refused`,
        async (_name, sql, value) => {
          const sessionHash = await hashSessionCookie(member.cookieValue);
          const response = await atEventRead(
            kind,
            phase,
            async (db) => {
              await expect(run(db, sql, [value, sessionHash])).rejects.toThrow(/immutable/);
            },
            () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}`),
          );
          expect(response.status).toBe(200);
        },
      );

  // Reads no longer carry the credential keyset (no commitment, no initializer, no 503), so a
  // changed or removed keyset moves nothing under an event read.
  it.each(['detail', 'list'] as const)(
    'reads %s normally when the credential keyset changes mid-read',
    async (kind) => {
      await withMutableKeyset(async () => {
        const response = await atEventRead(
          kind,
          'row',
          async (db) => {
            await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
              '0'.repeat(64),
            ]);
          },
          () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}`),
        );
        expect(response.status).toBe(200);
      });
    },
  );

  it.each(['detail', 'list'] as const)(
    'does not reveal keyset state after %s authority is revoked',
    async (kind) => {
      await withMutableKeyset(async () => {
        const response = await atEventRead(
          kind,
          'row',
          async (db) => {
            await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
              clock.now(),
              membershipId,
            ]);
            await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
              '0'.repeat(64),
            ]);
          },
          () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}`),
        );
        if (kind === 'detail') expect(response.status).toBe(403);
        else {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ items: [], nextCursor: null });
        }
      });
    },
  );
});
