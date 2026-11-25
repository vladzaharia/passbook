import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUICK_MESSAGES } from '@/shared/copy/quick-messages.ts';
import { QuickMessages } from './quick-messages.tsx';

afterEach(cleanup);

describe('QuickMessages', () => {
  it('shows a chip per starter and fills the editor on a tap', async () => {
    const onPick = vi.fn();
    render(<QuickMessages value="" onPick={onPick} />);
    expect(screen.getAllByRole('button')).toHaveLength(QUICK_MESSAGES.length);
    await userEvent.click(screen.getByRole('button', { name: 'Running late' }));
    expect(onPick).toHaveBeenCalledWith(QUICK_MESSAGES[1]?.text);
  });

  it('marks the chip whose text is in the editor', () => {
    render(<QuickMessages value={QUICK_MESSAGES[0]?.text ?? ''} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Doors open' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
