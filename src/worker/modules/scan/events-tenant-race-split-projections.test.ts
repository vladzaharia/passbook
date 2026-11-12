import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { pageOf, ScanEventSchema } from '../../../shared/contracts/index.ts';
import { run } from '../../platform/db.ts';
import { createEventTenantRace } from './events-tenant-race-split-fixture.ts';

const HOUR = 3_600_000;
const race = createEventTenantRace();
let { env, f, clock, orgId, eventId, attachedScanner } = race;
beforeEach(() => {
  ({ env, f, clock, orgId, eventId, attachedScanner } = race);
});
const { admittedPass, atEventRead, call } = race;

describe('final event count projections', () => {
  for (const [kind, phase] of [
    ['detail', 'row'],
    ['detail', 'cache'],
    ['list', 'row'],
    ['list', 'cache'],
  ] as const) {
    it.each(['quarantine', 'presence', 'foreign scanner'] as const)(
      `reselects ${kind} after %s changes at ${phase}`,
      async (change) => {
        const pass = await admittedPass();
        await run(env.DB, 'UPDATE scan_events SET expected=NULL,expected_at=NULL WHERE id=?', [
          eventId,
        ]);
        const other = change === 'foreign scanner' ? await makeOrg(f) : null;
        const response = await atEventRead(
          kind,
          phase,
          async (db) => {
            if (change === 'quarantine') {
              await run(db, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id]);
            } else if (change === 'presence') {
              await run(db, 'DELETE FROM scan_presence WHERE pass_id=? AND scope=?', [
                pass.id,
                `event:${eventId}`,
              ]);
              await run(db, 'DELETE FROM scan_gates WHERE pass_id=? AND scope=?', [
                pass.id,
                `event:${eventId}`,
              ]);
            } else {
              if (!other) throw new Error('Missing foreign tenant.');
              // A device binding names the scanner's org; it must go before the scanner can move.
              await run(db, 'DELETE FROM scanning_devices WHERE scanner_id=?', [
                attachedScanner.id,
              ]);
              await run(db, 'UPDATE scanners SET org_id=? WHERE id=?', [
                other.id,
                attachedScanner.id,
              ]);
            }
          },
          () => call('GET', kind === 'detail' ? `/${eventId}` : `?orgId=${orgId}`),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        const event =
          kind === 'detail'
            ? ScanEventSchema.parse(body)
            : pageOf(ScanEventSchema)
                .parse(body)
                .items.find((item) => item.id === eventId);
        expect(event).toMatchObject({
          arrived: 0,
          expected: change === 'quarantine' ? 0 : 1,
          scanners: change === 'foreign scanner' ? 0 : 1,
        });
      },
    );
  }

  it('reselects an initially empty list after an event appears', async () => {
    const id = f.ids.id();
    const response = await atEventRead(
      'list',
      'row',
      async (db) => {
        await run(
          db,
          `INSERT INTO scan_events
        (id,org_id,mode,name,opens_at,closes_at,time_zone,created_at,updated_at)
        VALUES (?,?,'live','Appeared',?,?,'UTC',?,?)`,
          [id, orgId, clock.now() - HOUR, clock.now() + HOUR, clock.now(), clock.now()],
        );
      },
      () => call('GET', `?orgId=${orgId}&q=Appeared`),
    );
    expect(response.status).toBe(200);
    expect(
      pageOf(ScanEventSchema)
        .parse(await response.json())
        .items.map((item) => item.id),
    ).toEqual([id]);
  });
});
