import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignedOutCard } from './session-ended.tsx';

describe('SignedOutCard', () => {
  it('is a Signed out hosted card with Sign in again', async () => {
    const onSignIn = vi.fn();
    render(<SignedOutCard size="hosted" onSignIn={onSignIn} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Signed out' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
