import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScanCond } from '@/passkit/template/scan-display/schema.ts';
import '../../../../lib/test-utils.tsx';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { manifest } from './scan-fields-test-fixtures.ts';

const numericManifest = {
  ...manifest,
  inputs: {
    ...manifest.inputs,
    properties: { ...manifest.inputs.properties, quantity: { type: 'number' } },
  },
};

describe('scan condition builder', () => {
  it('edits typed enum values while retaining the input shorthand', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(
      <ScanConditionField
        value={{ input: 'quantity', eq: 1 }}
        manifest={manifest}
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Value' }));
    await user.click(screen.getByRole('option', { name: '2' }));
    expect(changed).toHaveBeenLastCalledWith({ input: 'quantity', eq: 2 }, undefined);
  });

  it('edits membership tests and converts input shorthand for numeric comparisons', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const original: ScanCond = { input: 'tier', in: ['Standard', 'VIP'] };
    const { rerender } = render(
      <ScanConditionField
        value={original}
        manifest={manifest}
        audienceRole="desk"
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove value 1' }));
    expect(changed).toHaveBeenLastCalledWith({ input: 'tier', in: ['VIP'] }, undefined);
    expect(original).toEqual({ input: 'tier', in: ['Standard', 'VIP'] });
    rerender(
      <ScanConditionField
        value={{ input: 'quantity', eq: 1 }}
        manifest={manifest}
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Comparison' }));
    await user.click(screen.getByRole('option', { name: 'Greater than' }));
    expect(changed.mock.lastCall?.[0]).toEqual({ path: 'inputs.quantity', gt: 0 });
  });

  it('retains the later duplicate membership value and its numeric draft', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const initial: ScanCond = { input: 'quantity', in: [2, 2] };
    function Example() {
      const [value, setValue] = useState<ScanCond | undefined>(initial);
      return (
        <ScanConditionField
          value={value}
          manifest={numericManifest}
          mergeKey="scan:r:when"
          onChange={(next, merge) => {
            changed(next, merge);
            setValue(next);
          }}
        />
      );
    }
    render(<Example />);
    const first = screen.getByRole('spinbutton', { name: 'Value 1' });
    const later = screen.getByRole('spinbutton', { name: 'Value 2' }) as HTMLInputElement;
    expect(first).not.toBe(later);
    await user.click(later);
    fireEvent.change(later, { target: { value: '2.00' } });
    expect(later.value).toBe('2.00');
    expect(changed).toHaveBeenLastCalledWith(initial, 'scan:r:when:value:1');

    await user.click(screen.getByRole('button', { name: 'Remove value 1' }));
    expect(changed).toHaveBeenLastCalledWith({ input: 'quantity', in: [2] }, undefined);
    expect(screen.getByRole('spinbutton', { name: 'Value 1' })).toBe(later);
    expect(later.value).toBe('2.00');
    expect(first).not.toBeInTheDocument();
    expect(initial).toEqual({ input: 'quantity', in: [2, 2] });
  });

  it('retains the later duplicate condition and its numeric draft', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const leaf: ScanCond = { path: 'inputs.quantity', gt: 2 };
    const initial: ScanCond = { all: [leaf, { ...leaf }] };
    const original = structuredClone(initial);
    function Example() {
      const [value, setValue] = useState<ScanCond | undefined>(initial);
      return (
        <ScanConditionField
          value={value}
          manifest={numericManifest}
          mergeKey="scan:r:when"
          onChange={(next, merge) => {
            changed(next, merge);
            setValue(next);
          }}
        />
      );
    }
    render(<Example />);
    const values = screen.getAllByRole('spinbutton', { name: 'Value' });
    expect(values).toHaveLength(2);
    const first = values[0] as HTMLElement;
    const later = values[1] as HTMLInputElement;
    expect(first).not.toBe(later);
    await user.click(later);
    fireEvent.change(later, { target: { value: '2.00' } });
    expect(later.value).toBe('2.00');
    expect(changed).toHaveBeenLastCalledWith(original, 'scan:r:when:1:value');

    await user.click(screen.getByRole('button', { name: 'Remove test 1' }));
    expect(changed).toHaveBeenLastCalledWith(
      { all: [{ path: 'inputs.quantity', gt: 2 }] },
      undefined,
    );
    expect(screen.getByRole('spinbutton', { name: 'Value' })).toBe(later);
    expect(later.value).toBe('2.00');
    expect(first).not.toBeInTheDocument();
    expect(initial).toEqual(original);
  });

  it('filters sensitive enum labels and uses a safe default without exposing existing values', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const withEnum = {
      ...manifest,
      inputs: {
        properties: {
          ...manifest.inputs.properties,
          category: {
            type: 'string',
            enum: ['person@example.test', '+1 212 555 0199', 'ABC-12345', 'VIP'],
          },
        },
      },
    };
    const { rerender } = render(
      <ScanConditionField
        value={{ path: 'inputs.category', eq: 'person@example.test' }}
        manifest={withEnum}
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Value' }));
    expect(screen.getByRole('option', { name: 'VIP' })).toBeInTheDocument();
    expect(screen.queryByText(/person@example|212 555|ABC-12345/)).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    rerender(
      <ScanConditionField
        value={{ path: 'inputs.category', empty: true }}
        manifest={withEnum}
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Comparison' }));
    await user.click(screen.getByRole('option', { name: 'Equals' }));
    expect(changed.mock.lastCall?.[0]).toEqual({ path: 'inputs.category', eq: 'VIP' });
  });

  it('builds and nests groups without changing the original test', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const initial: ScanCond = { input: 'quantity', eq: 2 };
    function Example() {
      const [value, setValue] = useState<ScanCond | undefined>(initial);
      return (
        <ScanConditionField
          value={value}
          manifest={manifest}
          mergeKey="scan:r:when"
          onChange={(next, merge) => {
            changed(next, merge);
            setValue(next);
          }}
        />
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('combobox', { name: 'Match' }));
    await user.click(screen.getByRole('option', { name: 'All tests' }));
    await user.click(screen.getByRole('button', { name: 'Add test' }));
    const matches = screen.getAllByRole('combobox', { name: 'Rule 2 match' });
    await user.click(matches[1] as HTMLElement);
    await user.click(screen.getByRole('option', { name: 'Not' }));
    expect(changed).toHaveBeenLastCalledWith(
      { all: [initial, { not: { path: 'holder.name', empty: false } }] },
      undefined,
    );
    expect(initial).toEqual({ input: 'quantity', eq: 2 });
  });

  it('round-trips nested all, any, not and two-sided calendar bounds immutably', () => {
    const changed = vi.fn();
    const condition: ScanCond = {
      all: [
        { input: 'quantity', eq: 2 },
        { not: { any: [{ path: 'pass.validUntil', daysFromNow: { gte: 0, lte: 30 } }] } },
      ],
    };
    const original = structuredClone(condition);
    render(
      <ScanConditionField
        value={condition}
        manifest={manifest}
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    expect(screen.getAllByText(/Custom condition · nested rule/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Maximum day count'), { target: { value: '45' } });
    expect(changed).toHaveBeenLastCalledWith(
      {
        all: [
          { input: 'quantity', eq: 2 },
          { not: { any: [{ path: 'pass.validUntil', daysFromNow: { gte: 0, lte: 45 } }] } },
        ],
      },
      expect.stringContaining('scan:r:when'),
    );
    expect(condition).toEqual(original);
  });

  it('does not expose a role-filtered condition value and preserves the original', () => {
    const changed = vi.fn();
    const condition: ScanCond = { path: 'inputs.tier', eq: 'PRIVATE_CONDITION' };
    render(
      <ScanConditionField
        value={condition}
        manifest={manifest}
        audienceRole="door"
        mergeKey="scan:r:when"
        onChange={changed}
      />,
    );
    expect(screen.getByText(/not available to this audience/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('PRIVATE_CONDITION')).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });
});
