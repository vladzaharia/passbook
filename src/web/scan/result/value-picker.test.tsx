import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import type { Card } from '../machine/types.ts';
import { ResultCard } from './result-card.tsx';

const action: Card['actions'][number] = {
  id: 'stamp',
  label: 'Add stamp',
  kind: 'add',
  available: true,
  lock: null,
  reason: null,
  amount: { max: 5, presets: [1, 2, 3], default: 1 },
  confirm: false,
  confirmAbove: null,
  cooldownRemainingMs: null,
  armable: 'once',
  rewardLabel: null,
};
const card = (over: Partial<Card> = {}) =>
  fixtureCard({
    actions: [action, { ...action, id: 'redeem', label: 'Redeem reward', kind: 'take' }],
    values: [
      {
        input: 'stamps',
        label: 'Stamps',
        before: 7,
        after: null,
        goal: 10,
        format: 'number',
      },
    ],
    ...over,
  });
const desk = (over = {}) => ({
  picker: null,
  onAmount: vi.fn(),
  onValue: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  managers: [{ id: 'm1', name: 'Mara' }],
  onApprove: vi.fn(),
  ...over,
});

describe('the desk panel of the result card', () => {
  it('offers every action of the card, locked ones to a Manager PIN', () => {
    const onAction = vi.fn();
    render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', {
          card: card({
            actions: [
              action,
              { ...action, id: 'redeem', label: 'Redeem reward', available: false, lock: 'role' },
            ],
          }),
          display: fixtureDisplay('ready'),
        })}
        onAction={onAction}
        desk={desk()}
      />,
    );
    fireEvent.click(screen.getByTestId('scan-action-stamp'));
    expect(onAction).toHaveBeenCalledWith('stamp');
    expect(screen.getByTestId('scan-action-redeem')).toBeDisabled();
  });

  it('steps the amount and shows what the value becomes', () => {
    const d = desk({ picker: { actionId: 'stamp', amount: 2 } });
    render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', {
          card: card(),
          display: fixtureDisplay('ready'),
        })}
        desk={d}
      />,
    );
    expect(screen.getByTestId('scan-amount')).toHaveTextContent('2');
    expect(screen.getByTestId('scan-picker-change')).toHaveTextContent('Stamps: 7 → 9');
    fireEvent.click(screen.getByTestId('scan-amount-up'));
    expect(d.onAmount).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(d.onAmount).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByTestId('scan-picker-commit'));
    expect(d.onConfirm).toHaveBeenCalled();
  });

  it('types a value into a set, and holds the button until it fits', () => {
    const set = {
      ...action,
      id: 'seats',
      label: 'Set seats',
      kind: 'set' as const,
      amount: null,
      input: { type: 'integer' as const, label: 'Seats', min: 0, max: 9 },
    };
    const d = desk({ picker: { actionId: 'seats', amount: null, value: 12 } });
    render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', {
          card: card({ actions: [set] }),
          display: fixtureDisplay('ready'),
        })}
        desk={d}
      />,
    );
    expect(screen.getByTestId('scan-picker-commit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('scan-value-input'), { target: { value: '4' } });
    expect(d.onValue).toHaveBeenCalledWith(4);
  });

  it('will not take more than the card holds', () => {
    render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', {
          card: card({ actions: [{ ...action, kind: 'take' }] }),
          display: fixtureDisplay('ready'),
        })}
        desk={desk({ picker: { actionId: 'stamp', amount: 9 } })}
      />,
    );
    expect(screen.getByTestId('scan-picker-commit')).toBeDisabled();
  });

  it('asks a Manager PIN for a needs_approval answer', () => {
    const d = desk();
    render(
      <ResultCard
        outcome={fixtureOutcome('heads_up', 'needs_approval', {
          card: card(),
          display: fixtureDisplay('ok'),
          approvals: true,
        })}
        desk={d}
      />,
    );
    fireEvent.click(screen.getByTestId('scan-manager-pin'));
    expect(screen.getByTestId('scan-approval')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

describe('the money picker', () => {
  const money = (before: number, kind: 'add' | 'take' = 'take') =>
    card({
      actions: [
        {
          ...action,
          id: 'charge',
          label: 'Charge',
          kind,
          amount: { max: 50, presets: [2.5, 4.5], default: null },
        },
      ],
      values: [
        {
          input: 'balance',
          label: 'Balance',
          before,
          after: null,
          goal: null,
          format: 'currency',
          currency: 'USD',
        },
      ],
    });
  const show = (d: ReturnType<typeof desk>, c = money(10.1)) =>
    render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', { card: c, display: fixtureDisplay('ready') })}
        desk={d}
      />,
    );

  it('shows money chips and a decimal field with no stepper', () => {
    show(desk({ picker: { actionId: 'charge', amount: null } }));
    expect(screen.getByRole('button', { name: '$4.50' })).toBeInTheDocument();
    expect(screen.getByTestId('scan-money-input')).toHaveAttribute('inputmode', 'decimal');
    expect(screen.queryByTestId('scan-amount-up')).toBeNull();
    expect(screen.getByTestId('scan-picker-commit')).toBeDisabled();
  });

  it('types 4.50 and shows the balance after to the cent', () => {
    const d = desk({ picker: { actionId: 'charge', amount: null } });
    show(d);
    fireEvent.change(screen.getByTestId('scan-money-input'), { target: { value: '4.5' } });
    expect(d.onAmount).toHaveBeenCalledWith(4.5);
    expect(screen.getByTestId('scan-picker-change')).toHaveTextContent('Balance after: $5.60');
    expect(screen.getByTestId('scan-picker-commit')).toHaveTextContent('Charge $4.50');
    fireEvent.keyDown(screen.getByTestId('scan-money-input'), { key: 'Enter' });
    expect(d.onConfirm).toHaveBeenCalled();
  });

  it('a chip fills the field', () => {
    const d = desk({ picker: { actionId: 'charge', amount: null } });
    show(d);
    fireEvent.click(screen.getByRole('button', { name: '$2.50' }));
    expect(d.onAmount).toHaveBeenCalledWith(2.5);
    expect(screen.getByTestId('scan-money-input')).toHaveValue('2.50');
  });

  it('refuses a third decimal in words', () => {
    const d = desk({ picker: { actionId: 'charge', amount: null } });
    show(d);
    fireEvent.change(screen.getByTestId('scan-money-input'), { target: { value: '4.505' } });
    expect(screen.getByTestId('scan-money-error')).toHaveTextContent('Use at most 2 decimals.');
    expect(screen.getByTestId('scan-picker-commit')).toBeDisabled();
    // No amount: the machine drops it, so the customer screen stops showing the last one.
    expect(d.onAmount).toHaveBeenCalledOnce();
    expect(d.onAmount).toHaveBeenCalledWith(null);
  });

  it('holds the button when the balance is short', () => {
    show(desk({ picker: { actionId: 'charge', amount: 12 } }));
    expect(screen.getByTestId('scan-picker-commit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('scan-money-input'), { target: { value: '10.10' } });
    expect(screen.getByTestId('scan-picker-commit')).toBeEnabled();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ResultCard
        outcome={fixtureOutcome('ready', 'choose', {
          card: money(10.1),
          display: fixtureDisplay('ready'),
        })}
        desk={desk({ picker: { actionId: 'charge', amount: 4.5 } })}
      />,
    );
    fireEvent.change(screen.getByTestId('scan-money-input'), { target: { value: '4.505' } });
    expect((await axe(container)).violations).toEqual([]);
  });
});
