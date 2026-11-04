import { describe, expect, it } from 'vitest';
import type { BehaviorContext, Json, PassJson } from '../../types.ts';
import { validatePass } from '../../validate.ts';
import { type BeaconsConfig, beacons } from './index.ts';

const ctx: BehaviorContext = {
  now: new Date('2030-01-01T00:00:00Z'),
  identity: { passTypeIdentifier: 'p', teamIdentifier: 't' },
  lookups: {},
};
const U1 = '8DEEFBB9-F738-4297-8040-96668BB44281';
const U2 = '2f234454-cf6d-4a0f-adf2-f4911ba9ffa6';

const run = (input: Record<string, Json>, config: BeaconsConfig, pass = {} as PassJson) => {
  beacons.apply(pass, input, config, ctx);
  return pass;
};

describe('beacons', () => {
  it('puts static beacons before input beacons and upper-cases UUIDs', () => {
    const p = run(
      { list: [{ proximityUUID: U2, major: 1, minor: 2, relevantText: ' Welcome ' }] },
      { input: 'list', beacons: [{ proximityUUID: U1, major: 7 }] },
    );
    expect(p.beacons).toEqual([
      { proximityUUID: U1, major: 7 },
      { proximityUUID: U2.toUpperCase(), major: 1, minor: 2, relevantText: 'Welcome' },
    ]);
  });

  it('collapses duplicates and stops at 10', () => {
    const list = Array.from({ length: 14 }, (_, i) => ({ proximityUUID: U1, major: i % 12 }));
    const p = run({ list }, { input: 'list' });
    expect(p.beacons).toHaveLength(10);
    expect(run({ list }, { input: 'list', max: 3 }).beacons).toHaveLength(3);
  });

  it('removes the key when there are none', () => {
    const p = run({}, { input: 'list' }, { beacons: [{ proximityUUID: U1 }] } as PassJson);
    expect(p.beacons).toBeUndefined();
    expect(run({ list: [] }, { input: 'list' }).beacons).toBeUndefined();
  });

  it('names the row that is wrong', () => {
    expect(() => run({ list: [{ proximityUUID: 'nope' }] }, { input: 'list' })).toThrow(
      /Beacon 1 needs a UUID/,
    );
    expect(() => run({ list: [{ proximityUUID: U1, major: 70000 }] }, { input: 'list' })).toThrow(
      /major/,
    );
    expect(() => run({ list: [{ proximityUUID: U1, minor: 3 }] }, { input: 'list' })).toThrow(
      /set major/,
    );
    expect(() => run({ list: 'x' }, { input: 'list' })).toThrow(/not a list/);
  });

  it('produces beacons the validator accepts', () => {
    const p = run({ list: [{ proximityUUID: U1, major: 1, minor: 2 }] }, { input: 'list' });
    const issues = validatePass(
      {
        ...p,
        formatVersion: 1,
        serialNumber: 's',
        description: 'd',
        organizationName: 'o',
        passTypeIdentifier: 'p',
        teamIdentifier: 'TEAM123456',
        generic: { primaryFields: [{ key: 'a', value: 'b' }] },
      } as PassJson,
      [],
      { passTypeIdentifier: 'p', teamIdentifier: 'TEAM123456' },
    ).issues.filter((i) => i.code.startsWith('BEACON'));
    expect(issues).toEqual([]);
  });
});
