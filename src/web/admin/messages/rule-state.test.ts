import { describe, expect, it } from 'vitest';
import type { FieldDef } from '../passes/schema-form/index.ts';
import { bodyOf, emptyClause, INITIAL_RULE, type RuleState } from './rule-state.ts';

const field = (key: string, widget: FieldDef['widget']) => ({ key, widget }) as FieldDef;
const fields = new Map([
  ['expiry', field('expiry', 'date')],
  ['tier', field('tier', 'select')],
  ['visits', field('visits', 'number')],
]);
const ready: RuleState = {
  ...INITIAL_RULE,
  name: 'Renewal',
  templateIds: ['t1'],
  anchor: 'expiry',
  message: 'Your card ends soon.',
  timeZone: 'Europe/London',
};

describe('bodyOf', () => {
  it('builds a body for a complete rule', () => {
    const { body, errors } = bodyOf('o1', ready, fields);
    expect(errors).toEqual({});
    expect(body).toMatchObject({
      orgId: 'o1',
      anchor: { kind: 'input', input: 'expiry' },
      offset: { amount: 7, unit: 'day', when: 'before' },
      clearAfter: 7 * 86_400_000,
    });
    expect(body?.match).toBeUndefined();
  });

  it('names what is missing', () => {
    const { body, errors } = bodyOf('o1', { ...INITIAL_RULE }, fields);
    expect(body).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(['anchor', 'message', 'name', 'templates']);
  });

  it('turns conditions into clauses by input kind', () => {
    const { body } = bodyOf(
      'o1',
      {
        ...ready,
        match: [
          { ...emptyClause('tier'), values: ['gold'] },
          { ...emptyClause('visits'), min: '3' },
          { ...emptyClause('expiry'), to: '2027-01-31' },
        ],
      },
      fields,
    );
    expect(body?.match).toEqual([
      { input: 'tier', values: ['gold'] },
      { input: 'visits', min: 3 },
      { input: 'expiry', to: '2027-01-31', timeZone: 'Europe/London' },
    ]);
  });

  it('refuses an unfinished condition', () => {
    const { body, errors } = bodyOf('o1', { ...ready, match: [emptyClause('tier')] }, fields);
    expect(body).toBeUndefined();
    expect(errors.match).toBe('Finish or remove the condition.');
  });

  it('uses the shared rule checks', () => {
    const { errors } = bodyOf('o1', { ...ready, sendAt: '06:00' }, fields);
    expect(errors.sendAt).toBe('Pick a time between 08:00 and 20:30.');
    const last = bodyOf('o1', { ...ready, anchor: 'lastScan', when: 'before' }, fields);
    expect(last.errors.offset).toBe('Count days after the last scan.');
  });
});
