import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { ResultCard } from './result-card.tsx';

const desk = (over = {}) => ({
  picker: null,
  onAmount: vi.fn(),
  onValue: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  managers: [
    { id: 'm1', name: 'Mara' },
    { id: 'm2', name: 'Noor' },
  ],
  onApprove: vi.fn(),
  ...over,
});
const needs = () =>
  fixtureOutcome('heads_up', 'needs_approval', {
    card: fixtureCard(),
    display: fixtureDisplay('ok'),
    approvals: true,
    action: { id: 'stamp', label: 'Add stamp', kind: 'add' },
  });
const type = (digits: string) =>
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: digits } });

describe('Use manager code', () => {
  it('offers the code with no name picked when staff sign-in is off', () => {
    const d = desk({ code: true });
    render(<ResultCard outcome={needs()} desk={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use manager code' }));
    expect(screen.getByText('Manager code')).toBeVisible();
    expect(screen.getByText('Add stamp needs a manager.')).toBeVisible();
    expect(screen.queryByText('Manager')).toBeNull();
    const go = screen.getByRole('button', { name: 'Continue' });
    expect(go).toBeDisabled();
    type('654321');
    fireEvent.click(go);
    expect(d.onApprove).toHaveBeenCalledWith(undefined, '654321');
  });

  it('keeps the named manager when staff sign-in is on', () => {
    render(<ResultCard outcome={needs()} desk={desk({ code: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    expect(screen.getByText('Manager')).toBeVisible();
    expect(screen.queryByText('Manager code')).toBeNull();
  });

  it('says how many tries are left, and reopens after a refused code', () => {
    const { rerender } = render(<ResultCard outcome={needs()} desk={desk({ code: true })} />);
    expect(screen.queryByTestId('scan-approval')).toBeNull();
    rerender(<ResultCard outcome={needs()} desk={desk({ code: true, note: { triesLeft: 4 } })} />);
    expect(screen.getByText('Wrong code. 4 tries left.')).toBeVisible();
  });

  it('locks the field when the tries are used up', () => {
    render(
      <ResultCard
        outcome={needs()}
        desk={desk({ code: true, note: { locked: true, retryAfterMs: 240_000 } })}
      />,
    );
    expect(screen.getByText('Too many tries. Try again in 4 min.')).toBeVisible();
    expect(screen.getByLabelText('6-digit code')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('shows the real wait: person lock in minutes, hourly lock as 1 hour', () => {
    const { rerender } = render(
      <ResultCard
        outcome={needs()}
        desk={desk({ code: true, note: { locked: true, retryAfterMs: 61_000 } })}
      />,
    );
    expect(screen.getByText('Too many tries. Try again in 2 min.')).toBeVisible();
    rerender(
      <ResultCard
        outcome={needs()}
        desk={desk({ code: true, note: { locked: true, retryAfterMs: 1_000 } })}
      />,
    );
    expect(screen.getByText('Too many tries. Try again in 1 min.')).toBeVisible();
    rerender(
      <ResultCard
        outcome={needs()}
        desk={desk({ code: true, note: { locked: true, retryAfterMs: 3_000_000 } })}
      />,
    );
    expect(screen.getByText('Too many tries. Try again in 50 min.')).toBeVisible();
    rerender(
      <ResultCard
        outcome={needs()}
        desk={desk({ code: true, note: { locked: true, retryAfterMs: 3_540_001 } })}
      />,
    );
    expect(screen.getByText('Too many tries. Try again in 1 hour.')).toBeVisible();
  });
});
