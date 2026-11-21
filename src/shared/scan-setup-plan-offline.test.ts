import { describe, expect, it } from 'vitest';
import { codes, ctxOf, plan, planned } from './scan-setup-plan-test-fixtures.ts';

const event = (n: number) => ({
  name: `Night ${n}`,
  opensAt: 1_000 + n,
  closesAt: 9_000 + n,
  timeZone: null,
  match: null,
  existingId: null,
});
const template = (id: string, count: number) => ({
  id,
  name: id,
  plans: null,
  issued: { live: 1, test: 0 },
  upcomingEvents: Array.from({ length: count }, (_, n) => event(n)),
});

describe('event_night and the offline list', () => {
  const reentry = {
    id: 'event_re',
    name: 'Re-entry',
    templateIds: ['tpl_ticket'],
    reentry: true,
    capacity: 100,
  };
  it('adds the list to an entry-only door and leaves it off a door that needs exits', () => {
    const ctx = ctxOf({ events: [reentry] });
    const plain = planned(
      { preset: 'event_night', doors: [{ name: 'Plain', admits: { templateIds: ['tpl_day'] } }] },
      ctx,
    );
    expect(plain.sessions[0]?.settings).toMatchObject({ offline: true, whenOffline: 'list' });
    const exits = planned(
      { preset: 'event_night', doors: [{ name: 'Exits', admits: { events: ['event_re'] } }] },
      ctx,
    );
    expect(exits.sessions[0]?.settings.offline).toBeUndefined();
    expect(exits.checks.map((c) => c.code)).not.toContain('OFFLINE_LIST_BLOCKED');
  });

  it('flags an explicit list on a door that needs exits as an error', () => {
    const p = planned(
      {
        doors: [
          {
            name: 'Blocked',
            admits: { events: ['event_re'] },
            more: { offline: true, whenOffline: 'list' },
          },
        ],
      },
      ctxOf({ events: [reentry] }),
    );
    expect(p.checks).toContainEqual(
      expect.objectContaining({ code: 'OFFLINE_LIST_BLOCKED', level: 'error' }),
    );
  });
});

describe('events a setup makes', () => {
  it('refuses more than ten in all, across fromTemplate entries', () => {
    const ctx = ctxOf({ templates: [template('tpl_a', 6), template('tpl_b', 6)] });
    const intent = {
      events: [{ fromTemplate: 'tpl_a' }, { fromTemplate: 'tpl_b' }],
      doors: [{ name: 'Door', admits: { templateIds: ['tpl_a'] } }],
    };
    expect(codes(intent, ctx)).toContain('SETUP_TOO_MANY_NEW_EVENTS');
    expect(
      plan(intent, ctxOf({ templates: [template('tpl_a', 5), template('tpl_b', 5)] })).ok,
    ).toBe(true);
  });
});
