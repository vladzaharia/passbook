import { describe, expect, it } from 'vitest';
import {
  type ScanDisplayDoc,
  ScanDisplayDocSchema,
} from '@/passkit/template/scan-display/schema.ts';
import { sampleDoc } from '../fixtures.ts';
import { resetPanel, type ScanSelectionResult, scanSelectionAction } from './scan-outline-model.ts';

function applied(result: ScanSelectionResult) {
  if (result.kind !== 'change') throw new Error(`Expected change, received ${result.kind}`);
  return result;
}

function fixture(): ScanDisplayDoc {
  return {
    v: 1,
    header: { chips: [{ id: 'c_header', text: 'VIP', tone: 'gold' }] },
    variants: [
      {
        id: 'v_rule',
        name: 'Member',
        when: { path: 'pass.status', eq: 'active' },
        header: { chips: [{ id: 'c_variant', text: 'Member', tone: 'teal' }] },
      },
    ],
    panels: [
      {
        id: 'p_main',
        rows: [
          { id: 'r_image', type: 'image', source: 'thumbnail' },
          {
            id: 'r_list',
            type: 'list',
            items: [
              { id: 'i_a', icon: 'star', text: 'A' },
              { id: 'i_b', icon: 'key', text: 'B' },
            ],
          },
          { id: 'r_field', type: 'field', label: 'Member', value: 'Name' },
        ],
      },
      { id: 'p_next', rows: [{ id: 'r_next', type: 'field', label: 'Type', value: 'General' }] },
    ],
    customer: { chips: ['c_header', 'c_variant'], panel: 'p_main' },
  };
}
const ids = (doc: ScanDisplayDoc) => [
  ...(doc.header.chips ?? []).map((chip) => chip.id),
  ...(doc.variants ?? []).flatMap((variant) => [
    variant.id,
    ...(variant.header.chips ?? []).map((chip) => chip.id),
  ]),
  ...(doc.panels ?? []).flatMap((panel) => [
    panel.id,
    ...panel.rows.flatMap((row) => [
      row.id,
      ...('items' in row ? row.items.map((item) => item.id) : []),
    ]),
  ]),
];

describe('scan selection actions', () => {
  it('duplicates a nested panel with distinct ids, without mutating the original', () => {
    const original = fixture();
    const before = structuredClone(original);
    const result = applied(scanSelectionAction(original, 'p_main', 'duplicate'));
    expect(result.display.panels).toHaveLength(3);
    expect(result.selected).not.toBe('p_main');
    const all = ids(result.display);
    expect(new Set(all).size).toBe(all.length);
    expect(result.display.panels?.[1]?.rows[1]).toMatchObject({
      type: 'list',
      items: [{ text: 'A' }, { text: 'B' }],
    });
    expect(ScanDisplayDocSchema.safeParse(result.display).success).toBe(true);
    expect(original).toEqual(before);
  });

  it('requires panel removal confirmation and clears its customer reference', () => {
    const doc = fixture();
    expect(scanSelectionAction(doc, 'p_main', 'remove')).toMatchObject({
      kind: 'confirm',
      panelId: 'p_main',
    });
    const result = applied(scanSelectionAction(doc, 'p_main', 'remove', true));
    expect(result.selected).toBeNull();
    expect(result.display.panels?.map((panel) => panel.id)).toEqual(['p_next']);
    expect(result.display.customer?.panel).toBeNull();
    expect(doc.customer?.panel).toBe('p_main');
  });

  it('blocks illegal placement but lets ordinary rows move', () => {
    const doc = fixture();
    expect(scanSelectionAction(doc, 'r_image', 'down')).toMatchObject({
      kind: 'blocked',
      message: expect.stringMatching(/image goes first/i),
    });
    const result = applied(scanSelectionAction(doc, 'r_field', 'up'));
    expect(result.display.panels?.[0]?.rows.map((row) => row.id)).toEqual([
      'r_image',
      'r_field',
      'r_list',
    ]);
  });

  it('leaves an editable invalid draft when the last row is removed', () => {
    const doc = fixture();
    const result = applied(scanSelectionAction(doc, 'r_next', 'remove'));
    expect(result.selected).toBe('p_next');
    expect(result.display.panels?.[1]?.rows).toEqual([]);
    expect(ScanDisplayDocSchema.safeParse(result.display).success).toBe(false);
  });

  it('moves, duplicates and removes group items with valid bounds', () => {
    const doc = fixture();
    const moved = applied(scanSelectionAction(doc, 'i_b', 'up')).display;
    expect(moved.panels?.[0]?.rows[1]).toMatchObject({ items: [{ id: 'i_b' }, { id: 'i_a' }] });
    const duplicate = applied(scanSelectionAction(moved, 'i_a', 'duplicate'));
    const all = ids(duplicate.display);
    expect(new Set(all).size).toBe(all.length);
    const removed = applied(scanSelectionAction(duplicate.display, 'i_a', 'remove'));
    expect(removed.selected).toBe('r_list');
    expect(removed.display.panels?.[0]?.rows[1]).toMatchObject({
      items: [{ id: 'i_b' }, { text: 'A' }],
    });
  });

  it('cleans references when a chip or a variant is removed', () => {
    const doc = fixture();
    const chip = applied(scanSelectionAction(doc, 'c_header', 'remove'));
    expect(chip.display.customer?.chips).toEqual(['c_variant']);
    const variant = applied(scanSelectionAction(chip.display, 'v_rule', 'remove'));
    expect(variant.display.customer?.chips).toEqual([]);
    expect(variant.selected).toBe('rules');
    expect(scanSelectionAction(doc, 'notes', 'remove').kind).toBe('blocked');
  });

  it('rebuilds preset rows using existing mappings and preserves author-added rows', () => {
    const template = sampleDoc();
    template.manifest.inputs = {
      type: 'object',
      properties: { stand: { type: 'string' }, spot: { type: 'string' } },
    };
    const display: ScanDisplayDoc = {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p_ticket',
          preset: { id: 'ticket', v: 1 },
          title: 'My ticket',
          rows: [
            {
              id: 'r_seat',
              slot: 'seat',
              type: 'columns',
              size: 'big',
              items: [
                { id: 'i_section_1', label: 'Custom section', value: '{{inputs.stand}}' },
                { id: 'i_seat_1', label: 'Custom seat', value: '{{inputs.spot}}' },
              ],
            },
            { id: 'r_custom', type: 'field', label: 'Custom', value: 'Note' },
          ],
        },
      ],
    };
    const before = structuredClone(display);
    const reset = resetPanel(
      template,
      display,
      display.panels?.[0] as NonNullable<ScanDisplayDoc['panels']>[number],
    );
    expect(reset?.title).toBe('My ticket');
    expect(reset?.rows).toMatchObject([
      { type: 'columns', items: [{ value: '{{inputs.stand}}' }, { value: '{{inputs.spot}}' }] },
      { id: 'r_custom', type: 'field', label: 'Custom' },
    ]);
    expect(display).toEqual(before);
  });
});
