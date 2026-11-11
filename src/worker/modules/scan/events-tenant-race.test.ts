import { beforeEach, describe, expect, it } from 'vitest';
import { pageOf, ScanEventSchema } from '../../../shared/contracts/index.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority } from './events.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';
import { getAuthorizedConsoleEvent, listConsoleEvents } from './repo-events.ts';

const race = createEventTenantRace();
let { env, clock, orgId, eventId, member, membershipId } = race;
beforeEach(() => {
  ({ env, clock, orgId, eventId, member, membershipId } = race);
});
const { atEventRead, call, state, withMutableKeyset, withRemovableKeyset } = race;

const withoutCache = <T extends object>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (key, v) => (key === 'expected' || key === 'expected_at' ? null : v)),
  );

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

  it.each([
    ['detail', 'before-row', false],
    ['detail', 'row', false],
    ['detail', 'cache', false],
    ['list', 'before-row', false],
    ['list', 'row', false],
    ['list', 'cache', false],
    ['list', 'before-row', true],
    ['list', 'row', true],
  ] as const)('rejects a changed keyset for %s at %s (empty: %s)', async (kind, phase, empty) => {
    await withMutableKeyset(async () => {
      const before = await state();
      const response = await atEventRead(
        kind,
        phase,
        async (db) => {
          await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
            '0'.repeat(64),
          ]);
        },
        () =>
          call(
            'GET',
            kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}${empty ? '&q=no-such-event' : ''}`,
          ),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      // The recount cache is volatile and may have been filled; nothing else moved.
      expect(withoutCache(await state())).toEqual(withoutCache(before));
    });
  });

  it.each(['detail', 'list'] as const)(
    'does not reinitialize a removed keyset for %s output',
    async (kind) => {
      await withRemovableKeyset(async () => {
        const response = await atEventRead(
          kind,
          'before-row',
          async (db) => {
            await run(db, 'DELETE FROM credential_ref_keyset WHERE id=1');
          },
          () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}&q=no-such-event`),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
        expect(
          await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
        ).toBeNull();
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

  it('binds the captured keyset to the event row and list SQL, even when the page is empty', async () => {
    const ctx = createServiceContext(env, { clock });
    const auth = await createSessionStore(env, clock).resolve(member.cookieValue);
    if (!auth) throw new Error('Missing reader session.');
    const authority = await captureEventAuthority(
      ctx,
      auth,
      await tenantAuthorityOf(ctx, auth, orgId, 'scanning:read'),
    );
    const commitment = await ensureCredentialRefKeyset(env.DB, env);
    await withMutableKeyset(async () => {
      await run(env.DB, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
        '0'.repeat(64),
      ]);
      await expect(
        getAuthorizedConsoleEvent(env.DB, eventId, authority, clock.now(), commitment),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      const filter = {
        orgId,
        mode: 'live' as const,
        now: clock.now(),
        limit: 50,
        authority,
        credentialKeysetCommitment: commitment,
      };
      await expect(listConsoleEvents(env.DB, filter)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      await expect(
        listConsoleEvents(env.DB, { ...filter, q: 'no-such-event' }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    });
  });
});
