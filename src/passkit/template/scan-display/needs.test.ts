import { describe, expect, it } from 'vitest';
import { compileNeeds } from './needs.ts';
import type { ScanDisplayDoc } from './schema.ts';

describe('compileNeeds', () => {
  it('records nothing for a header-only doc', () => {
    expect(compileNeeds({ v: 1, header: { title: 'Hi' } })).toEqual({
      history: [],
      ledger: [],
      fields: false,
      photo: false,
      event: false,
    });
  });

  it('records what the texts, conditions and rows read', () => {
    const doc = {
      v: 1,
      photo: {},
      header: { subtitle: '{{fields.seat}} {{event.name}}' },
      variants: [
        { id: 'v', name: 'V', when: { path: 'history.visits.total', gte: 1 }, header: {} },
      ],
      panels: [
        {
          id: 'p',
          rows: [
            { id: 'r_a', type: 'field', label: 'L', value: '{{history.lastVisit.at|ago}}' },
            { id: 'r_b', type: 'field', label: 'L', value: '{{history.ledger.balance.month.in}}' },
            { id: 'r_c', type: 'history', source: 'value', input: 'stamps' },
            { id: 'r_d', type: 'history', source: 'scans' },
            { id: 'r_e', type: 'image', source: 'strip' },
          ],
        },
      ],
    } as ScanDisplayDoc;
    expect(compileNeeds(doc)).toEqual({
      history: ['lastVisit', 'ledgerMonth:balance', 'scans', 'visits'],
      ledger: ['stamps'],
      fields: true,
      photo: true,
      event: true,
    });
  });
});
