import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PairView } from './pair-view.tsx';

describe('PairView', () => {
  it('keeps a code whose preview failed, so Pair can be pressed again', () => {
    const onPair = vi.fn();
    render(
      <PairView onPair={onPair} error="Too many tries. Wait a minute." initialCode="ABCDE12345" />,
    );
    const pair = screen.getByRole('button', { name: 'Pair' });
    expect(pair).toBeEnabled();
    fireEvent.click(pair);
    expect(onPair).toHaveBeenCalledWith('ABCDE12345');
  });

  it('starts empty and disabled without a failed code', () => {
    render(<PairView onPair={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
  });
});
