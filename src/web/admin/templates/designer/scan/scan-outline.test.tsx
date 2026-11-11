import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PRESET_ORDER } from '@/passkit/template/scan-display/presets.ts';
import {
  type ScanDisplayDoc,
  ScanDisplayDocSchema,
} from '@/passkit/template/scan-display/schema.ts';
import { fixture, setup } from './scan-outline-test-fixtures.ts';

const panelIds = (display: ScanDisplayDoc) => [
  ...(display.header.chips ?? []).map((chip) => chip.id),
  ...(display.variants ?? []).flatMap((variant) => [
    variant.id,
    ...(variant.header.chips ?? []).map((chip) => chip.id),
  ]),
  ...(display.panels ?? []).flatMap((panel) => [
    panel.id,
    ...panel.rows.flatMap((row) => [
      row.id,
      ...('items' in row ? row.items.map((item) => item.id) : []),
    ]),
  ]),
];

describe('scan screen outline', () => {
  it('does not persist the default until requested, and exposes every preset and an empty panel', async () => {
    const user = userEvent.setup();
    const doc = fixture();
    const before = structuredClone(doc);
    const view = setup(doc, null);
    expect(view.changes).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Use the default' })).toBeInTheDocument();
    for (const id of PRESET_ORDER) {
      const labels = {
        membership: 'Membership',
        loyalty: 'Loyalty',
        balance: 'Balance',
        ticket: 'Ticket',
        offer: 'Offer',
        access: 'Access',
        details: 'Details',
        note: 'Note',
      };
      expect(screen.getByRole('radio', { name: new RegExp(labels[id]) })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: /Empty panel/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use the default' }));
    expect(view.changes).toHaveLength(1);
    expect(ScanDisplayDocSchema.safeParse(view.latest()).success).toBe(true);
    expect(doc).toEqual(before);
  });

  it('adds Ticket with four mapped columns and keeps document ids unique when adding it again', async () => {
    const user = userEvent.setup();
    const doc = fixture();
    const before = structuredClone(doc);
    const view = setup(doc, null);
    await user.click(screen.getByRole('radio', { name: /Ticket/ }));
    await user.click(screen.getByRole('button', { name: 'Add Ticket' }));
    // The panel joins the default screen rather than replacing it.
    const first = view.latest()?.panels?.at(-1);
    const count = view.latest()?.panels?.length ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(first?.preset?.id).toBe('ticket');
    expect(first?.rows[0]).toMatchObject({
      type: 'columns',
      items: [
        { label: 'Section', value: '{{inputs.section}}' },
        { label: 'Row', value: '{{inputs.row}}' },
        { label: 'Seat', value: '{{inputs.seat}}' },
        { label: 'Gate', value: '{{inputs.gate}}' },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Add panel' }));
    await user.click(screen.getByRole('radio', { name: /Ticket/ }));
    await user.click(screen.getByRole('button', { name: 'Add Ticket' }));
    const latest = view.latest();
    expect(latest?.panels).toHaveLength(count + 1);
    const ids = panelIds(latest as ScanDisplayDoc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ScanDisplayDocSchema.safeParse(latest).success).toBe(true);
    expect(doc).toEqual(before);
  });

  it.each(PRESET_ORDER)('creates a schema-valid editable %s preset', async (id) => {
    const user = userEvent.setup();
    const view = setup(fixture(), null);
    const names = {
      membership: 'Membership',
      loyalty: 'Loyalty',
      balance: 'Balance',
      ticket: 'Ticket',
      offer: 'Offer',
      access: 'Access',
      details: 'Details',
      note: 'Note',
    };
    await user.click(screen.getByRole('radio', { name: new RegExp(names[id]) }));
    await user.click(screen.getByRole('button', { name: `Add ${names[id]}` }));
    const result = view.latest();
    expect(result?.panels?.at(-1)?.preset?.id).toBe(id);
    expect(result?.panels?.at(-1)?.rows.length).toBeGreaterThan(0);
    expect(ScanDisplayDocSchema.safeParse(result).success).toBe(true);
  });

  it('keeps a true empty panel editable and blocks saving until a row is added', async () => {
    const user = userEvent.setup();
    const view = setup(fixture(), null);
    await user.click(screen.getByRole('button', { name: 'Add empty panel' }));
    expect(view.latest()?.panels?.at(-1)?.rows).toEqual([]);
    expect(ScanDisplayDocSchema.safeParse(view.latest()).success).toBe(false);
    expect(screen.getByText('This panel is empty. Add a row before saving.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add row' }));
    await user.click(screen.getByRole('button', { name: 'Add field row' }));
    expect(view.latest()?.panels?.at(-1)?.rows).toMatchObject([{ type: 'field', value: '' }]);
    expect(ScanDisplayDocSchema.safeParse(view.latest()).success).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Remove Field 1' }));
    // The removed row's button is gone: focus moves to what is selected now.
    const panelId = view.latest()?.panels?.at(-1)?.id ?? '';
    await waitFor(() =>
      expect(view.container.querySelector(`[data-target="scan-display:${panelId}"]`)).toHaveFocus(),
    );
    expect(view.latest()?.panels?.at(-1)?.rows).toEqual([]);
    expect(ScanDisplayDocSchema.safeParse(view.latest()).success).toBe(false);
    expect(screen.getByRole('button', { name: 'Add row' })).toBeInTheDocument();
  });

  it('moves rows with Alt+Arrow, rejects an illegal image move, and never mutates the input', () => {
    const doc = fixture();
    const display: ScanDisplayDoc = {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p_test',
          title: 'Details',
          rows: [
            { id: 'r_image', type: 'image', source: 'thumbnail' },
            { id: 'r_first', type: 'field', label: 'First', value: 'One' },
            { id: 'r_second', type: 'field', label: 'Second', value: 'Two' },
          ],
        },
      ],
    };
    const original = structuredClone(display);
    const view = setup(doc, display, 'p_test');
    const first = view.container.querySelector(
      '[data-target="scan-display:r_first"]',
    ) as HTMLElement;
    fireEvent.keyDown(first, { altKey: true, key: 'ArrowDown' });
    expect(view.changes).toHaveLength(1);
    expect(view.latest()?.panels?.[0]?.rows.map((row) => row.id)).toEqual([
      'r_image',
      'r_second',
      'r_first',
    ]);
    expect(display).toEqual(original);
    const image = view.container.querySelector(
      '[data-target="scan-display:r_image"]',
    ) as HTMLElement;
    fireEvent.keyDown(image, { altKey: true, key: 'ArrowDown' });
    expect(view.changes).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('An image goes first');
  });

  it('leaves the source panel empty after transferring its last row', async () => {
    const user = userEvent.setup();
    const display: ScanDisplayDoc = {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p_source',
          title: 'Source',
          rows: [{ id: 'r_source', type: 'field', label: 'Name', value: 'Member' }],
        },
        {
          id: 'p_target',
          title: 'Destination',
          rows: [{ id: 'r_target', type: 'field', label: 'Type', value: 'General' }],
        },
      ],
    };
    const before = structuredClone(display);
    const view = setup(fixture(), display, 'r_source');
    await user.click(screen.getByRole('combobox', { name: 'Move row to panel' }));
    await user.click(screen.getByRole('option', { name: 'Destination' }));
    expect(view.latest()?.panels?.[0]?.rows).toEqual([]);
    expect(view.latest()?.panels?.[1]?.rows.map((row) => row.id)).toEqual(['r_target', 'r_source']);
    expect(ScanDisplayDocSchema.safeParse(view.latest()).success).toBe(false);
    expect(display).toEqual(before);
  });

  it('removes customer references when deleting a chip, without editing the original', async () => {
    const user = userEvent.setup();
    const display: ScanDisplayDoc = {
      v: 1,
      header: { chips: [{ id: 'c_plan', text: 'Plan', tone: 'teal' }] },
      customer: { chips: ['c_plan'], panel: null },
    };
    const original = structuredClone(display);
    const view = setup(fixture(), display, 'header');
    await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
    expect(view.latest()?.header.chips).toEqual([]);
    expect(view.latest()?.customer).toEqual({ chips: [], panel: null });
    expect(display).toEqual(original);
  });

  it('adds a first-match rule and updates its name in a mergeable change', async () => {
    const user = userEvent.setup();
    const view = setup(fixture(), { v: 1, header: {} }, 'rules');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const variant = view.latest()?.variants?.[0];
    expect(variant?.when).toEqual({ path: 'pass.status', eq: 'active' });
    expect(
      view.container.querySelector(`[data-target="scan-display:${variant?.id}"]`),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Members' } });
    expect(view.latest()?.variants?.[0]?.name).toBe('Members');
    expect(view.changes.at(-1)?.merge).toBe(`scan:${variant?.id}:name`);
  });

  it('locks result title and icon on heads-up, and exposes only the refused note on refused', () => {
    const doc = fixture();
    const display: ScanDisplayDoc = {
      v: 1,
      header: { title: 'Welcome', icon: 'star' },
      notes: { refused: 'Ask a manager' },
    };
    const view = setup(doc, display, 'header', 'heads_up');
    expect(screen.getByText(/heads-up headlines and icons cannot be changed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Result title')).not.toBeInTheDocument();
    view.unmount();
    const refused = setup(doc, display, null, 'refused');
    expect(screen.getByLabelText('Refused note')).toHaveValue('Ask a manager');
    expect(screen.queryByRole('button', { name: 'Add panel' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Staff note')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Refused note'), {
      target: { value: 'Please ask the desk' },
    });
    expect(refused.latest()?.notes?.refused).toBe('Please ask the desk');
    expect(refused.changes.at(-1)?.merge).toBe('scan:notes:refused');
  });
});
