import { describe, expect, it } from 'vitest';
import { visitorInput, visitorTemplates } from './template.ts';

const guest = {
  inputs: {
    properties: {
      memberName: {},
      memberId: {},
      plan: {},
      sponsor: {},
      validFrom: {},
      note: {},
    },
  },
  scan: {
    actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    access: {
      input: { plan: 'plan', from: 'validFrom', sponsor: 'sponsor' },
      plans: [
        { id: 'member', label: 'Member', kind: 'always', zones: [{ zone: '*' }] },
        { id: 'guest', label: 'Guest', kind: 'guest', days: 1, visits: 1, zones: [{ zone: '*' }] },
      ],
    },
  },
};
const member = {
  inputs: { properties: { memberName: {} } },
  scan: {
    actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }],
    access: {
      input: { plan: 'plan', from: 'validFrom' },
      plans: [{ id: 'member', label: 'Member', kind: 'always', zones: [{ zone: '*' }] }],
    },
  },
};

describe('visitorTemplates', () => {
  it('keeps only templates with a guest plan, in the order given', () => {
    const found = visitorTemplates([
      { id: 'a', name: 'Member', manifest: JSON.stringify(member) },
      { id: 'b', name: 'Guest', manifest: JSON.stringify(guest) },
      { id: 'c', name: 'Broken', manifest: '{' },
    ]);
    expect(found.map((t) => t.id)).toEqual(['b']);
  });
});

describe('visitorInput', () => {
  const facts = {
    name: 'Leo Park',
    hostName: 'Ana Ruiz',
    windowFrom: Date.UTC(2026, 10, 25, 9),
    note: 'Bring ID',
    code: 'V-ABCD1234',
  };

  it('fills the inputs the template has: name, pass ID, plan, start, host and note', () => {
    expect(visitorInput(guest, facts)).toEqual({
      memberName: 'Leo Park',
      memberId: 'V-ABCD1234',
      plan: 'guest',
      validFrom: '2026-11-25T09:00:00.000Z',
      sponsor: 'Ana Ruiz',
      note: 'Bring ID',
    });
  });

  it('leaves out inputs the template lacks, and refuses a template with no guest plan', () => {
    const slim = { ...guest, inputs: { properties: { memberName: {} } } };
    expect(visitorInput(slim, facts)).toEqual({ memberName: 'Leo Park', plan: 'guest' });
    expect(visitorInput(member, facts)).toBeNull();
  });
});
