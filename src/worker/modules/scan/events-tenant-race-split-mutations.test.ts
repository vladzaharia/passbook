import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { ScanEventSchema } from '../../../shared/contracts/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';
import { makeLegacyScanPass } from './test-kit.ts';

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
  primaryTemplate,
  secondaryTemplate,
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
    primaryTemplate,
    secondaryTemplate,
  } = race);
});
const { atEventCommit, atEventRead, call, state, withMutableKeyset } = race;

describe('event mutation response', () => {
  it.each(['membership', 'session'] as const)(
    'preserves a committed update when %s is revoked after its transaction',
    async (changed) => {
      const sessionHash = await hashSessionCookie(member.cookieValue);
      const response = await atEventCommit(
        async (db) => {
          if (changed === 'membership') {
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              membershipId,
            ]);
          } else {
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              sessionHash,
            ]);
          }
        },
        () => call('PATCH', `/${eventId}`, { name: 'Committed' }),
        'after-commit',
      );
      expect(response.status).toBe(200);
      expect(ScanEventSchema.parse(await response.json()).name).toBe('Committed');
      expect(
        await first<{ name: string; expected: number | null; expected_at: number | null }>(
          env.DB,
          'SELECT name, expected, expected_at FROM scan_events WHERE id = ?',
          [eventId],
        ),
      ).toEqual({ name: 'Committed', expected: null, expected_at: null });
      // The file shares one database across tests: count this event's audit only.
      expect(
        await all(
          env.DB,
          "SELECT id FROM audit_log WHERE action = 'scan_event.update' AND target_id = ?",
          [eventId],
        ),
      ).toHaveLength(1);
    },
  );

  it('uses the committed live count rather than a fresh but stale expected cache', async () => {
    await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    await run(env.DB, 'UPDATE scan_events SET expected=99,expected_at=? WHERE id=?', [
      clock.now(),
      eventId,
    ]);
    const response = await call('POST', `/${eventId}/scanners`, { scannerIds: [] });
    expect(response.status).toBe(200);
    expect(ScanEventSchema.parse(await response.json()).expected).toBe(1);
    expect(
      await first(env.DB, 'SELECT expected,expected_at FROM scan_events WHERE id=?', [eventId]),
    ).toEqual({ expected: 99, expected_at: clock.now() });
  });

  it('returns the committed snapshot but cannot cache it if the keyset changes afterward', async () => {
    await withMutableKeyset(async () => {
      const response = await atEventCommit(
        async (db) => {
          await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
            '0'.repeat(64),
          ]);
        },
        () => call('PATCH', `/${eventId}`, { name: 'Committed' }),
        'after-commit',
      );
      expect(response.status).toBe(200);
      expect(ScanEventSchema.parse(await response.json()).name).toBe('Committed');
      expect(
        await first(env.DB, 'SELECT name,expected,expected_at FROM scan_events WHERE id=?', [
          eventId,
        ]),
      ).toEqual({ name: 'Committed', expected: null, expected_at: null });
    });
  });
});

describe('event target scope races', () => {
  const operations = [
    ['edit', () => call('PATCH', `/${eventId}`, { opensAt: clock.now() + 10 * HOUR })],
    ['archive', () => call('POST', `/${eventId}/archive`)],
    ['assign', () => call('POST', `/${eventId}/scanners`, { scannerIds: [] })],
  ] as const;

  it.each(operations)('masks a moved event before %s validation', async (_label, operation) => {
    const otherOrgId = (await makeOrg(f)).id;
    let movedState: unknown;
    const response = await atEventRead(
      'detail',
      'target',
      async (db) => {
        await run(db, 'UPDATE scan_events SET org_id=?,archived_at=? WHERE id=?', [
          otherOrgId,
          clock.now(),
          eventId,
        ]);
        movedState = await state();
      },
      operation,
    );
    expect(response.status).toBe(404);
    expect(await state()).toEqual(movedState);
  });
});

describe('event release races', () => {
  const cases = [
    [
      'create',
      () => primaryTemplate,
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
      'replace templates',
      () => secondaryTemplate,
      () =>
        call('PATCH', `/${eventId}`, {
          templateIds: [secondTemplateId],
        }),
    ],
    [
      'assign scanners',
      () => primaryTemplate,
      () =>
        call('POST', `/${eventId}/scanners`, {
          scannerIds: [freeScannerId],
        }),
    ],
  ] as const;

  it.each(cases)(
    'rolls back %s if its scoped release changes at commit',
    async (_name, fixture, operation) => {
      const before = await state();
      const response = await atEventCommit(async (db) => {
        const template = fixture();
        await approveAppleRelease(
          { ctx: createServiceContext(env, { clock }), fx: f, registry: template.registry },
          {
            orgId,
            templateId: template.resolved.id,
            version: template.resolved.version,
            mode: 'live',
            db,
          },
        );
      }, operation);
      expect(response.status).toBe(409);
      expect(await state()).toEqual(before);
    },
  );
});

describe('event assignment races', () => {
  it('does not assign a scanner revoked after validation', async () => {
    const eventBefore = await first(env.DB, 'SELECT * FROM scan_events WHERE id=?', [eventId]);
    const templatesBefore = await all(
      env.DB,
      'SELECT * FROM scanner_templates WHERE scanner_id=?',
      [freeScannerId],
    );
    const sessionsBefore = await all(env.DB, 'SELECT * FROM scanning_sessions WHERE id=?', [
      freeScannerId,
    ]);
    const response = await atEventCommit(
      async (db) => {
        await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [clock.now(), freeScannerId]);
      },
      () => call('POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] }),
    );
    expect(response.status).toBe(409);
    expect(await first(env.DB, 'SELECT * FROM scan_events WHERE id=?', [eventId])).toEqual(
      eventBefore,
    );
    expect(
      await first(env.DB, 'SELECT event_id FROM scanners WHERE id=?', [freeScannerId]),
    ).toEqual({ event_id: null });
    expect(
      await all(env.DB, 'SELECT * FROM scanner_templates WHERE scanner_id=?', [freeScannerId]),
    ).toEqual(templatesBefore);
    expect(
      await all(env.DB, 'SELECT * FROM scanning_sessions WHERE id=?', [freeScannerId]),
    ).toEqual(sessionsBefore);
    expect(await all(env.DB, "SELECT * FROM audit_log WHERE action='scan_event.assign'")).toEqual(
      [],
    );
  });
});
