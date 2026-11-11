import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import { ScanEventSchema } from '../../../shared/contracts/index.ts';
import { run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';
import { grantScanMembership } from './test-kit.ts';

const HOUR = 3_600_000;
const race = createEventTenantRace();
let {
  env,
  f,
  clock,
  orgId,
  templateId,
  secondTemplateId,
  eventId,
  freeScannerId,
  member,
  membershipId,
} = race;
beforeEach(() => {
  ({
    env,
    f,
    clock,
    orgId,
    templateId,
    secondTemplateId,
    eventId,
    freeScannerId,
    member,
    membershipId,
  } = race);
});
const { atEventCommit, call, state } = race;

/** Restore and an already-archived archive start from an archived event. */
async function prepare(label: string) {
  if (label !== 'restore' && label !== 'archive an already archived event') return;
  await run(env.DB, 'UPDATE scan_events SET archived_at = ? WHERE id = ?', [clock.now(), eventId]);
  await run(env.DB, 'UPDATE scanners SET event_id = NULL WHERE event_id = ?', [eventId]);
  await run(
    env.DB,
    "UPDATE scanning_sessions SET accepts = NULL WHERE json_extract(accepts, '$.eventId') = ?",
    [eventId],
  );
}

describe('event mutation commit authority', () => {
  const operations = [
    [
      'create',
      () =>
        call('POST', '', {
          orgId,
          name: 'New event',
          templateIds: [templateId],
          opensAt: clock.now() - HOUR,
          closesAt: clock.now() + HOUR,
          timeZone: 'UTC',
        }),
    ],
    [
      'edit and replace templates',
      () =>
        call('PATCH', `/${eventId}`, {
          name: 'Changed',
          templateIds: [secondTemplateId],
        }),
    ],
    ['edit and archive', () => call('PATCH', `/${eventId}`, { archived: true })],
    ['restore', () => call('PATCH', `/${eventId}`, { archived: false })],
    ['archive', () => call('POST', `/${eventId}/archive`)],
    ['archive an already archived event', () => call('POST', `/${eventId}/archive`)],
    [
      'assign scanners',
      () => call('POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] }),
    ],
    ['assign no scanners', () => call('POST', `/${eventId}/scanners`, { scannerIds: [] })],
  ] as const;

  it('uses the captured commitment instead of deriving it again at commit', async () => {
    const key = env.KEK_V1;
    try {
      const response = await atEventCommit(
        async () => {
          Object.assign(env, { KEK_V1: btoa('z'.repeat(32)) });
        },
        () => call('PATCH', `/${eventId}`, { name: 'Original keyset' }),
      );
      expect(response.status).toBe(200);
      expect(ScanEventSchema.parse(await response.json()).name).toBe('Original keyset');
    } finally {
      Object.assign(env, { KEK_V1: key });
    }
  });

  for (const [label, operation] of operations) {
    it.each([
      'membership',
      'session',
      'replacement membership',
      'session expiry',
      'disabled user',
      'suspended organization',
    ] as const)(`does not ${label} when %s changes at commit`, async (changed) => {
      await prepare(label);
      const before = await state();
      const sessionHash = await hashSessionCookie(member.cookieValue);
      // A second active session cannot substitute for the exact session used by the request.
      await makeSession(f, { userId: member.userId });
      const response = await atEventCommit(async (db) => {
        if (changed === 'session') {
          await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
            clock.now(),
            sessionHash,
          ]);
        } else if (changed === 'session expiry') {
          await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
            clock.now(),
            sessionHash,
          ]);
        } else if (changed === 'disabled user') {
          await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [member.userId]);
        } else if (changed === 'suspended organization') {
          await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
        } else {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            clock.now(),
            membershipId,
          ]);
          if (changed === 'replacement membership') {
            await grantScanMembership(f, orgId, member.userId);
          }
        }
      }, operation);
      expect(response.status).toBe(403);
      expect(await state()).toEqual(before);
    });
  }

  // Session roles, authentication method and CSRF secret are fixed at sign-in (migration 0047):
  // the edit itself is refused, so nothing can change under the request and it succeeds.
  for (const [label, operation] of operations) {
    it.each([
      ['session roles', 'UPDATE sessions SET roles = ? WHERE id_hash = ?', '["admin","user"]'],
      [
        'session authentication method',
        "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ? AND ? IS NOT NULL",
        'x',
      ],
      ['session csrf', 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', 'replacement'],
    ] as const)(
      `still ${label} when the %s edit is refused at commit`,
      async (kind, sql, value) => {
        await prepare(label);
        const sessionHash = await hashSessionCookie(member.cookieValue);
        const params =
          kind === 'session authentication method' ? [sessionHash, value] : [value, sessionHash];
        const response = await atEventCommit(async (db) => {
          await expect(run(db, sql, params)).rejects.toThrow(/immutable/);
        }, operation);
        expect([200, 201]).toContain(response.status);
      },
    );
  }
});
