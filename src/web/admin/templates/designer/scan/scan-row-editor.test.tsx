import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScanRowDoc } from '@/passkit/template/scan-display/schema.ts';
import '../../../../lib/test-utils.tsx';
import { ScanRowEditor } from './scan-row-editor.tsx';

const manifest = {
  inputs: {
    properties: {
      quantity: { type: 'integer' },
      tier: { type: 'string', 'x-scan': 'desk' },
      phone: { type: 'string', 'x-scan': 'door' },
    },
  },
  bindings: [],
  scan: {
    actions: [
      { id: 'credit', label: 'Credit', kind: 'add', input: 'quantity' },
      { id: 'secret', label: 'Private', kind: 'set', input: 'phone' },
    ],
  },
};

const samples: { row: ScanRowDoc; label: string }[] = [
  { row: { id: 'heading', type: 'heading', text: 'Heading' }, label: 'Heading' },
  { row: { id: 'field', type: 'field', label: 'Seat', value: 'A' }, label: 'Value' },
  { row: { id: 'big', type: 'big', value: '12' }, label: 'Value' },
  {
    row: {
      id: 'columns',
      type: 'columns',
      items: [
        { id: 'one', label: 'Row', value: 'A' },
        { id: 'two', label: 'Seat', value: '1' },
      ],
    },
    label: 'Column size',
  },
  {
    row: { id: 'progress', type: 'progress', value: '{{inputs.quantity}}' },
    label: 'Progress value',
  },
  { row: { id: 'money', type: 'money', amount: '{{inputs.quantity}}' }, label: 'Amount' },
  { row: { id: 'history', type: 'history', source: 'scans' }, label: 'History source' },
  { row: { id: 'image', type: 'image', source: 'strip' }, label: 'Image source' },
  {
    row: { id: 'chips', type: 'chips', items: [{ id: 'chip', text: 'VIP', tone: 'gold' }] },
    label: 'Chip text',
  },
  {
    row: { id: 'list', type: 'list', items: [{ id: 'item', text: 'Lounge', icon: 'key' }] },
    label: 'Item text',
  },
  { row: { id: 'note', type: 'note', text: 'Welcome' }, label: 'Note' },
  { row: { id: 'divider', type: 'divider' }, label: 'Who sees it' },
];

function Controlled({
  initial,
  changed,
}: {
  initial: ScanRowDoc;
  changed: (row: ScanRowDoc, merge?: string) => void;
}) {
  const [row, setRow] = useState(initial);
  return (
    <ScanRowEditor
      row={row}
      manifest={manifest}
      onChange={(next, merge) => {
        changed(next, merge);
        setRow(next);
      }}
    />
  );
}

describe('scan row editor', () => {
  it.each(samples)('opens a $row.type inspector', ({ row, label }) => {
    render(<ScanRowEditor row={row} manifest={manifest} onChange={vi.fn()} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('edits a field without mutating it and coalesces typing by row and property', () => {
    const changed = vi.fn();
    const row: ScanRowDoc = { id: 'seat', type: 'field', label: 'Seat', value: 'A1', strong: true };
    Object.freeze(row);
    render(<ScanRowEditor row={row} manifest={manifest} onChange={changed} />);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'A2' } });
    expect(changed).toHaveBeenCalledWith({ ...row, value: 'A2' }, 'scan:seat:value');
    expect(row.value).toBe('A1');
  });

  it('adds, reorders and removes columns while preserving item identities and minimums', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const row: ScanRowDoc = {
      id: 'seat',
      type: 'columns',
      size: 'big',
      items: [
        { id: 'first', label: 'Row', value: 'A' },
        { id: 'second', label: 'Seat', value: '12' },
      ],
    };
    const original = structuredClone(row);
    const { container } = render(<Controlled initial={row} changed={changed} />);
    expect(screen.getByRole('button', { name: 'Remove item 1' })).toBeDisabled();
    expect(screen.getAllByText('About 8 characters fit on one line.')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    expect(changed).toHaveBeenLastCalledWith(
      { ...row, items: [...row.items, { id: 'i_1', label: '', value: '' }] },
      undefined,
    );
    expect(container.querySelector('[data-target="scan-display:i_1"]')).toHaveAttribute(
      'tabindex',
      '-1',
    );
    await user.click(screen.getByRole('button', { name: 'Move item 3 up' }));
    expect(changed.mock.lastCall?.[0].items.map((item: { id: string }) => item.id)).toEqual([
      'first',
      'i_1',
      'second',
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove item 2' }));
    expect(changed.mock.lastCall?.[0].items.map((item: { id: string }) => item.id)).toEqual([
      'first',
      'second',
    ]);
    expect(row).toEqual(original);
  });

  it('edits a list item audience and condition independently of its row', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const row: ScanRowDoc = {
      id: 'benefits',
      type: 'list',
      items: [{ id: 'lounge', icon: 'key', text: 'Lounge' }],
    };
    const { container } = render(<Controlled initial={row} changed={changed} />);
    const item = container.querySelector('[data-target="scan-display:lounge"]') as HTMLElement;
    await user.click(within(item).getByRole('radio', { name: 'Desk and up' }));
    expect(changed.mock.lastCall?.[0].items[0]).toEqual({ ...row.items[0], minRole: 'desk' });
    await user.click(within(item).getByRole('button', { name: 'Add condition' }));
    expect(changed.mock.lastCall?.[0].items[0]).toMatchObject({
      id: 'lounge',
      minRole: 'desk',
      when: { path: 'holder.name', empty: false },
    });
    expect(row.items[0]).toEqual({ id: 'lounge', icon: 'key', text: 'Lounge' });
  });

  it('adds chips up to the schema cap and keeps existing item IDs', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const row: ScanRowDoc = {
      id: 'badges',
      type: 'chips',
      items: [{ id: 'c_1', text: 'VIP', tone: 'gold' }],
    };
    render(<Controlled initial={row} changed={changed} />);
    for (let i = 0; i < 3; i += 1)
      await user.click(screen.getByRole('button', { name: 'Add chip' }));
    expect(changed.mock.lastCall?.[0].items.map((item: { id: string }) => item.id)).toEqual([
      'c_1',
      'c_2',
      'c_3',
      'c_4',
    ]);
    expect(screen.getByRole('button', { name: 'Add chip' })).toBeDisabled();
  });

  it('only offers role-safe action inputs for value history', async () => {
    const user = userEvent.setup();
    const row: ScanRowDoc = { id: 'ledger', type: 'history', source: 'value' };
    render(<ScanRowEditor row={row} manifest={manifest} onChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Tracked input' }));
    expect(screen.getByRole('option', { name: 'quantity' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'phone' })).not.toBeInTheDocument();
  });

  it('hides unsafe action labels and numeric literals without changing the row', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const row: ScanRowDoc = {
      id: 'balance',
      type: 'money',
      amount: '{{inputs.quantity}}',
      lowBelow: 12125550199,
    };
    const privateLabels = {
      ...manifest,
      scan: {
        actions: [{ id: 'credit', kind: 'add', input: 'quantity', label: 'person@example.test' }],
      },
    };
    render(<ScanRowEditor row={row} manifest={privateLabels} onChange={changed} />);
    expect(screen.queryByText('person@example.test')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Action')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('12125550199')).not.toBeInTheDocument();
    expect(row.lowBelow).toBe(12125550199);
    await user.click(screen.getByRole('button', { name: 'Replace Low balance below' }));
    expect(changed).toHaveBeenCalledWith({ ...row, lowBelow: undefined }, undefined);
  });

  it('opens incomplete drafts without assuming item arrays or history sources', () => {
    const incomplete = { id: 'broken', type: 'history' } as unknown as ScanRowDoc;
    const { rerender } = render(
      <ScanRowEditor
        row={incomplete}
        manifest={{ inputs: null, bindings: [null], scan: { actions: [null] } }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Show in each entry')).toBeInTheDocument();
    rerender(
      <ScanRowEditor
        row={{ id: 'broken', type: 'columns' } as unknown as ScanRowDoc}
        manifest={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add column' })).toBeInTheDocument();
  });
});
