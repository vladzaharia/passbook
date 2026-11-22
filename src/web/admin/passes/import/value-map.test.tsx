import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MatchRow } from './match-model.ts';
import { ValueMap } from './match-rows.tsx';

const row = (values: MatchRow['values']) =>
  ({
    label: 'Membership',
    counted: true,
    options: [
      { value: 'member', label: 'Monthly' },
      { value: 'annual', label: 'Annual' },
    ],
    values,
  }) as unknown as MatchRow;

describe('the value map of a choice column', () => {
  const values = [
    { value: 'monthly', count: 5, to: 'member' },
    { value: 'MONTHLY', count: 2, to: 'member' },
    { value: 'Monthly ', count: 1, to: 'member' },
    { value: 'Gold', count: 3, to: null },
  ];

  it('lists spellings that differ only in case as one choice and names the others', () => {
    render(<ValueMap row={row(values)} canSkip={false} onChange={() => undefined} />);
    const map = screen.getByRole('list', { name: 'Membership values' });
    expect(within(map).getAllByRole('listitem')).toHaveLength(2);
    expect(within(map).getByText('monthly')).toBeInTheDocument();
    expect(within(map).getByText(/^Also written MONTHLY, Monthly/)).toBeInTheDocument();
    expect(within(map).getByText('8 rows')).toBeInTheDocument();
  });

  it('still asks about a value no option covers', () => {
    render(<ValueMap row={row(values)} canSkip={false} onChange={() => undefined} />);
    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });

  it('applies a pick to every spelling of the group', async () => {
    // Radix Select reads pointer capture and scrolls the option into view.
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.scrollIntoView = () => undefined;
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ValueMap row={row(values)} canSkip={false} onChange={onChange} />);
    await user.click(screen.getByRole('combobox', { name: /Option for monthly/ }));
    await user.click(await screen.findByRole('option', { name: 'Annual' }));
    expect(onChange).toHaveBeenCalledWith([
      { value: 'monthly', count: 5, to: 'annual' },
      { value: 'MONTHLY', count: 2, to: 'annual' },
      { value: 'Monthly ', count: 1, to: 'annual' },
      { value: 'Gold', count: 3, to: null },
    ]);
  });
});
