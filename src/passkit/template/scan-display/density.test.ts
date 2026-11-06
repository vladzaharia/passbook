import { describe, expect, it } from 'vitest';
import { DENSITY, density, headerCost, panelUnits, rowUnits } from './density.ts';
import type { ScanDisplayDoc, ScanRowDoc } from './schema.ts';

const doc = (patch: Record<string, unknown> = {}) =>
  ({ v: 1, header: {}, ...patch }) as ScanDisplayDoc;
const col = (n: number, size: 'big' | 'normal') =>
  ({
    id: 'r_c',
    type: 'columns',
    size,
    items: Array.from({ length: n }, (_, i) => ({ id: `i_${i}`, label: 'a', value: 'b' })),
  }) as ScanRowDoc;

describe('row units', () => {
  it('counts the worst case of each row type', () => {
    expect(rowUnits(col(2, 'big'))).toBe(2);
    expect(rowUnits(col(3, 'big'))).toBe(2);
    expect(rowUnits(col(4, 'big'))).toBe(3);
    expect(rowUnits(col(2, 'normal'))).toBe(1);
    expect(rowUnits(col(4, 'normal'))).toBe(2);
    expect(rowUnits({ id: 'r', type: 'progress', value: 'x', style: 'bar' })).toBe(2);
    expect(rowUnits({ id: 'r', type: 'progress', value: 'x' })).toBe(3);
    expect(rowUnits({ id: 'r', type: 'history', source: 'visits', limit: 3 })).toBe(2);
    expect(rowUnits({ id: 'r', type: 'history', source: 'value', limit: 3 })).toBe(2.5);
    expect(rowUnits({ id: 'r', type: 'divider' })).toBe(0);
  });

  it('sums a panel', () => {
    expect(panelUnits({ id: 'p', rows: [col(4, 'big'), col(2, 'normal')] })).toBe(4);
  });
});

describe('header cost', () => {
  const panels = [{ id: 'p', rows: [col(2, 'normal')] }];
  it('prices a custom title, a second line, heads_up, a photo, chips and a note', () => {
    expect(headerCost(doc(), 'ok')).toBe(0);
    expect(headerCost(doc({ header: { title: 'Welcome' } }), 'ok')).toBe(DENSITY.header.title);
    expect(headerCost(doc({ header: { title: 'Welcome back, {{holder.firstName}}' } }), 'ok')).toBe(
      3,
    );
    expect(headerCost(doc({ header: { title: 'Welcome' } }), 'heads_up')).toBe(2);
    expect(headerCost(doc({ photo: {} }), 'ok')).toBe(1);
    expect(
      headerCost(
        doc({
          photo: {},
          header: {
            chips: [
              { id: 'c', text: 'a', tone: 'gold' },
              { id: 'd', text: 'b', tone: 'gold' },
            ],
          },
        }),
        'ok',
      ),
    ).toBe(2);
    expect(headerCost(doc({ notes: { staff: 'x' } }), 'ready')).toBe(1);
    expect(headerCost(doc({ photo: {}, header: { title: 'T' } }), 'ready')).toBe(0);
    expect(headerCost(doc(), 'ok', 3)).toBe(1);
  });

  it('meets the six owner examples on ok (DM 1.6)', () => {
    expect(density(doc({ panels }))).toBe(2);
    const gym = doc({
      photo: { minRole: 'desk' },
      variants: [
        { id: 'v', name: 'Back', when: { path: 'a', eq: 1 }, header: { title: 'Welcome back' } },
      ],
      panels: [{ id: 'p', rows: [col(2, 'normal'), col(2, 'normal')] }],
    });
    expect(density(gym)).toBe(6);
  });
});
