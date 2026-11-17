import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
