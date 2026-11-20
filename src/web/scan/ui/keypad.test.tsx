import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { Keypad } from './keypad.tsx';

describe('Keypad', () => {
  it('sends each digit, and delete', () => {
    const onDigit = vi.fn();
    const onDelete = vi.fn();
    render(<Keypad onDigit={onDigit} onDelete={onDelete} />);
    for (const d of ['1', '5', '0']) fireEvent.click(screen.getByRole('button', { name: d }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDigit.mock.calls.map(([d]) => d)).toEqual(['1', '5', '0']);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('button')).toHaveLength(11);
  });

  it('puts a mode key at the bottom left and disables every key together', () => {
    render(
      <Keypad
        disabled
        onDigit={vi.fn()}
        onDelete={vi.fn()}
        corner={
          <button type="button" disabled>
            ABC
          </button>
        }
      />,
    );
    expect(screen.getByRole('button', { name: 'ABC' })).toBeDisabled();
    for (const key of screen.getAllByRole('button')) expect(key).toBeDisabled();
  });
});
