import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';

describe('loadTooltips', () => {
  it('never remounts a control that mounted before the chunk; later ones get tooltips', async () => {
    vi.resetModules();
    const { loadTooltips, TooltipProvider } = await import('./tooltip.tsx');
    const { IconButton } = await import('./icon-button.tsx');
    const icon = <span aria-hidden>x</span>;
    const { rerender } = render(
      <TooltipProvider>
        <IconButton label="Delete" icon={icon} />
      </TooltipProvider>,
    );
    const early = screen.getByRole('button', { name: 'Delete' });
    act(() => early.focus());
    await act(() => loadTooltips());
    rerender(
      <TooltipProvider>
        <IconButton label="Delete" icon={icon} />
        <IconButton label="Copy" icon={icon} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBe(early);
    expect(early).toHaveFocus();
    await userEvent.setup().tab();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy');
  });
});
