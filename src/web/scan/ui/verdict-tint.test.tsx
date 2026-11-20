import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VerdictTint } from './verdict-tint.tsx';

describe('the verdict tint', () => {
  it('dismisses on a tap outside the card, only while a verdict tints', () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(<VerdictTint tint="green" onDismiss={onDismiss} />);
    container.querySelector<HTMLButtonElement>('.scan-tint-dismiss')?.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<VerdictTint tint="none" onDismiss={onDismiss} />);
    expect(container.querySelector('.scan-tint-dismiss')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
