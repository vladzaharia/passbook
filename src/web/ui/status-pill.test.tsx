import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInMethodLabel } from '../lib/status.ts';
import { StatusIcon, StatusPill } from './status-pill.tsx';
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

describe('StatusPill vocabulary', () => {
  it('draws attribute markers neutral with their icon; teal is for actions', () => {
    for (const [key, label, icon] of [
      ['primary', 'Primary', 'lucide-star'],
      ['showing', 'Showing', 'lucide-eye'],
      ['this_device', 'This device', 'lucide-smartphone'],
      ['default', 'Default', 'lucide-badge-check'],
    ] as const) {
      const { container, unmount } = render(<StatusPill status={key} />);
      const pill = screen.getByText(label);
      expect(pill.className).toContain('text-fg-muted');
      expect(pill.className).not.toContain('accent');
      expect(container.querySelector('svg')?.getAttribute('class')).toContain(icon);
      unmount();
    }
  });

  it('knows In Wallet, Suspended and the email states', () => {
    for (const [key, label, tone] of [
      ['in_wallet', 'In Wallet', 'text-success'],
      ['suspended', 'Suspended', 'text-warning'],
      ['unverified', 'Not verified', 'text-fg-muted'],
      ['check_inbox', 'Check your inbox', 'text-fg-muted'],
    ] as const) {
      const { unmount } = render(<StatusPill status={key} />);
      expect(screen.getByText(label).className).toContain(tone);
      unmount();
    }
  });

  it('names sign-in methods from one map', () => {
    expect(signInMethodLabel('oidc')).toBe('Polaris ID');
    expect(signInMethodLabel('magic_link')).toBe('Email link');
    expect(signInMethodLabel('webauthn')).toBe('Webauthn');
  });
});
