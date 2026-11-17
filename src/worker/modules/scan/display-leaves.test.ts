import { describe, expect, it } from 'vitest';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { DROP, dropUnsafeLeaves, pruneDocument } from './display-leaves.ts';

const BAD = 'bad-secret-1';
const leaf = (value: unknown) => value !== BAD;
const keep = () => true;
const refuse = () => false;

describe('pruneDocument', () => {
  const doc = {
    v: 1,
    holder: '{{inputs.name}}',
    header: {
      title: 'Welcome',
      chips: [
        { id: 'c_a', text: 'Gold' },
        { id: 'c_b', text: BAD },
      ],
    },
    panels: [
      {
        id: 'p_one',
        title: 'Details',
        rows: [
          { id: 'r_a', type: 'field', label: 'Seat', value: 'C12' },
          { id: 'r_b', type: 'field', label: 'Code', value: BAD },
        ],
      },
      { id: 'p_two', rows: [{ id: 'r_c', type: 'field', label: BAD, value: 'x' }] },
    ],
  };

  it('drops the chip and row that hold a bad leaf, and a panel left without rows', () => {
    expect(pruneDocument(doc, leaf, keep)).toEqual({
      v: 1,
      holder: '{{inputs.name}}',
      header: { title: 'Welcome', chips: [{ id: 'c_a', text: 'Gold' }] },
      panels: [
        {
          id: 'p_one',
          title: 'Details',
          rows: [{ id: 'r_a', type: 'field', label: 'Seat', value: 'C12' }],
        },
      ],
    });
  });

  it('removes a bad slot instead of its parent when the parent is not an element', () => {
    expect(
      pruneDocument(
        { header: { title: BAD, subtitle: 'Fine' }, notes: { staff: BAD } },
        leaf,
        keep,
      ),
    ).toEqual({ header: { subtitle: 'Fine' }, notes: {} });
  });

  it('drops a columns row that falls under two items, and a plural that loses a form', () => {
    const rows = [
      {
        id: 'r_cols',
        type: 'columns',
        items: [
          { id: 'i_a', label: 'A', value: '1' },
          { id: 'i_b', label: 'B', value: BAD },
          { id: 'i_c', label: 'C', value: '3' },
        ],
      },
      {
        id: 'r_two',
        type: 'columns',
        items: [
          { id: 'i_a', label: 'A', value: '1' },
          { id: 'i_b', label: 'B', value: BAD },
        ],
      },
      {
        id: 'r_plural',
        type: 'field',
        label: 'Left',
        value: { count: '{{inputs.n}}', one: 'one left', other: BAD },
      },
    ];
    const pruned = pruneDocument({ panels: [{ id: 'p', rows }] }, leaf, keep) as {
      panels: { rows: { id: string; items?: unknown[] }[] }[];
    };
    expect(pruned.panels[0]?.rows.map((row) => row.id)).toEqual(['r_cols']);
    expect(pruned.panels[0]?.rows[0]?.items).toHaveLength(2);
  });

  it('drops an element whose condition is refused, never just the condition', () => {
    const pruned = pruneDocument(
      {
        panels: [
          { id: 'p', rows: [{ id: 'r_a', type: 'divider', when: { input: 'tier', empty: true } }] },
        ],
      },
      leaf,
      refuse,
    ) as { panels: unknown[] };
    expect(pruned.panels).toEqual([]);
    expect(pruneDocument({ id: 'x', type: 'divider', when: { input: 'a' } }, leaf, refuse)).toBe(
      DROP,
    );
  });
});

describe('dropUnsafeLeaves', () => {
  const display = (): ScanDisplay => ({
    v: 1,
    screen: 'ok',
    templateVersion: 'v1',
    variant: null,
    identity: { holder: 'Ada North', initials: 'AN', photo: null },
    header: {
      icon: null,
      title: 'Gold member',
      titleLines: 1,
      meta: null,
      chips: [
        { id: 'c_a', text: 'Gold', tone: 'gold', icon: null },
        { id: 'c_b', text: BAD, tone: 'teal', icon: null },
      ],
    },
    panels: [
      {
        id: 'p_a',
        kind: 'custom',
        title: 'Entry',
        icon: null,
        tone: null,
        rows: [
          { type: 'field', id: 'r_a', label: 'Seat', value: 'C12', icon: null, strong: false },
          { type: 'field', id: 'r_b', label: 'Code', value: BAD, icon: null, strong: false },
          {
            type: 'big',
            id: 'r_c',
            label: BAD,
            value: '42',
            unit: null,
            tone: null,
          },
        ],
      },
      {
        id: 'p_b',
        kind: 'custom',
        title: BAD,
        icon: null,
        tone: null,
        rows: [{ type: 'divider', id: 'r_d' }],
      },
    ],
    notes: { staff: BAD, refused: null },
  });

  it('returns the display itself when nothing is bad', () => {
    const shown = display();
    expect(dropUnsafeLeaves(shown, keep, 'Pass')).toBe(shown);
  });

  it('drops a chip and a row, blanks a nullable slot, keeps the rest', () => {
    const shown = dropUnsafeLeaves(display(), (value) => value !== BAD, 'Pass');
    expect(shown?.identity.holder).toBe('Ada North');
    expect(shown?.header.title).toBe('Gold member');
    expect(shown?.header.chips.map((chip) => chip.id)).toEqual(['c_a']);
    expect(shown?.notes.staff).toBeNull();
    expect(shown?.panels.map((panel) => panel.id)).toEqual(['p_a', 'p_b']);
    expect(shown?.panels[0]?.rows.map((row) => row.id)).toEqual(['r_a', 'r_c']);
    expect(shown?.panels[0]?.rows[1]).toMatchObject({ type: 'big', label: null, value: '42' });
    expect(shown?.panels[1]?.title).toBeNull();
    expect(JSON.stringify(shown)).not.toContain(BAD);
  });

  it('replaces a bad holder with the generic one', () => {
    const source = display();
    source.identity.holder = BAD;
    source.identity.initials = 'BS';
    const shown = dropUnsafeLeaves(source, (value) => value !== BAD && value !== 'BS', 'Pass');
    expect(shown?.identity).toMatchObject({ holder: 'Pass', initials: '' });
  });
});
