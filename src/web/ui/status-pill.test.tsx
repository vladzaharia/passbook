import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusIcon } from './status-pill.tsx';
import { TooltipProvider } from './tooltip.tsx';

const media = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: coarse && q.includes('pointer: coarse'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe('StatusIcon', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens its sentence on tap where there is no hover', async () => {
    media(true);
    render(<StatusIcon status="waiting" />);
    const icon = screen.getByRole('button');
    expect(icon.className).toContain('pointer-coarse:before:size-11');
    await userEvent.setup().click(icon);
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      icon.getAttribute('aria-label') ?? '',
    );
  });

  it('keeps the hover tooltip on fine pointers', async () => {
    media(false);
    render(
      <TooltipProvider delayDuration={0}>
        <StatusIcon status="waiting" />
      </TooltipProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
