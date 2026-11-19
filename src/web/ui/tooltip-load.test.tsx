import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';

describe('loadTooltips', () => {
  it('waits while a tooltipped control holds focus, then swaps tooltips in', async () => {
    vi.resetModules();
    const { loadTooltips, TooltipProvider } = await import('./tooltip.tsx');
    const { IconButton } = await import('./icon-button.tsx');
    render(
      <TooltipProvider>
        <IconButton label="Delete" icon={<span aria-hidden>x</span>} />
        <button type="button">Other</button>
      </TooltipProvider>,
    );
    const del = screen.getByRole('button', { name: 'Delete' });
    act(() => del.focus());
    await act(() => loadTooltips());
    expect(screen.getByRole('button', { name: 'Delete' })).toBe(del);
    expect(del).toHaveFocus();
    act(() => screen.getByRole('button', { name: 'Other' }).focus());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).not.toBe(del));
    expect(screen.getByRole('button', { name: 'Other' })).toHaveFocus();
  });
});
