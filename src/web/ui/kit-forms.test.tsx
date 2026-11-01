import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppleWalletBadge, appleWalletBadgeHtml } from './apple-wallet-badge.tsx';
import { JsonViewer } from './code-block.tsx';
import { DATE_RANGES, FilterBar, rangeStart } from './filter-bar.tsx';
import { Input } from './input.tsx';
import { CopyField, middle, SecretReveal } from './secret-reveal.tsx';
import { TooltipProvider } from './tooltip.tsx';
import { confirmWord, TypedConfirmDialog } from './typed-confirm-dialog.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

const wrap = (node: ReactNode) => <TooltipProvider>{node}</TooltipProvider>;

describe('TypedConfirmDialog', () => {
  it('picks a human word', () => {
    expect(confirmWord({ title: 'Northwind' })).toBe('Northwind');
    expect(confirmWord({ title: 'A title that is much longer than allowed', slug: 'nw' })).toBe(
      'nw',
    );
    expect(confirmWord({ title: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001' })).toBe('delete');
  });

  it('throws in dev for a UUID-shaped word', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <TypedConfirmDialog
          open
          onOpenChange={() => {}}
          title="Delete?"
          word="0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001"
          confirmLabel="Delete"
          onConfirm={async () => {}}
        />,
      ),
    ).toThrow(/human word/);
    vi.restoreAllMocks();
  });

  it('enables only on a matching word, case-insensitive and trimmed, with no X', async () => {
    const user = userEvent.setup();
    render(
      <TypedConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Northwind?"
        word="Northwind"
        confirmLabel="Delete"
        onConfirm={async () => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type Northwind to confirm'), '  northwind ');
    expect(confirm).toBeEnabled();
    expect(dialog.querySelector('.wl-check')).not.toBeNull();
  });
});

describe('SecretReveal', () => {
  it('masks values, copies from its own column and gates Done on saving', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      wrap(
        <SecretReveal
          fields={[{ label: 'API key', value: 'wk_live_abcdefghijklmnopqrstuvwxyz0123456789' }]}
          onDone={onDone}
        />,
      ),
    );
    expect(screen.getByText('Copy the secret now. It is not shown again.')).toBeInTheDocument();
    expect(screen.queryByText(/wk_live/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(
      screen.getByText(middle('wk_live_abcdefghijklmnopqrstuvwxyz0123456789')),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(done);
    expect(onDone).toHaveBeenCalled();
  });

  it('truncates in the middle', () => {
    expect(middle('abcdefghijklmnopqrstuvwxyz0123', 4)).toBe('abcd…0123');
    render(wrap(<CopyField label="Short" value="abc" secret={false} />));
    expect(screen.getByText('abc')).toBeInTheDocument();
  });
});

describe('JsonViewer', () => {
  it('tints keys, strings, numbers and booleans', () => {
    const { container } = render(
      wrap(<JsonViewer value={{ name: 'Ada', count: 3, active: true, none: null }} />),
    );
    const tones = new Set([...container.querySelectorAll('[data-token]')].map((s) => s.className));
    expect(tones.size).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('[data-token="key"]')).toHaveTextContent('"name"');
  });
});

describe('AppleWalletBadge', () => {
  it("uses Apple's artwork, switches to outline in dark and never animates", () => {
    const { container, rerender } = render(<AppleWalletBadge href="/p/x/pass.pkpass" />);
    const img = screen.getByRole('img', { name: 'Add to Apple Wallet' });
    expect(img.getAttribute('src')).toMatch(/^\/apple\/badge\/en\/black\.svg$/);
    expect(container.querySelector('source')?.getAttribute('media')).toBe(
      '(prefers-color-scheme: dark)',
    );
    const link = container.querySelector('a');
    expect(link?.className).not.toMatch(/transition|animate|scale|shadow|opacity/);
    expect(getComputedStyle(link as Element).transition || 'none').toMatch(/^(none|all 0s.*|)$/);
    document.documentElement.dataset.theme = 'dark';
    rerender(<AppleWalletBadge href="/p/x/pass.pkpass" label="All passes (3)" />);
    expect(screen.getByRole('img', { name: 'Add to Apple Wallet' }).getAttribute('src')).toBe(
      '/apple/badge/en/outline.svg',
    );
    expect(screen.getByText('All passes (3)')).toBeInTheDocument();
  });

  it('renders the same badge as HTML for SSR and email', () => {
    expect(appleWalletBadgeHtml({ href: '/p/a"b' })).toContain('href="/p/a&#34;b"');
    expect(appleWalletBadgeHtml({ href: '/x', email: { origin: 'https://w.example' } })).toContain(
      'https://w.example/apple/badge/en/black@2x.png',
    );
  });
});

describe('FilterBar', () => {
  it('renders "Label: value" triggers, fills set ones and offers Clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <FilterBar
        search={{ value: '', onChange: () => {}, placeholder: 'Search passes' }}
        onClear={onClear}
        filters={[
          {
            id: 'status',
            label: 'Status',
            value: 'voided',
            defaultValue: 'all',
            options: [
              { value: 'all', label: 'All' },
              { value: 'voided', label: 'Voided' },
            ],
            onChange: () => {},
          },
          {
            id: 'date',
            label: 'Date',
            value: 'any',
            defaultValue: 'any',
            options: DATE_RANGES,
            onChange: () => {},
          },
        ]}
      />,
    );
    const status = screen.getByRole('combobox', { name: 'Status: Voided' });
    expect(status).toHaveTextContent('Status:Voided');
    expect(status.className).toContain('bg-accent-subtle');
    expect(screen.getByRole('combobox', { name: 'Date: any' })).not.toHaveClass('bg-accent-subtle');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalled();
    expect(rangeStart('7d', 8 * 86_400_000)).toBe(86_400_000);
    expect(rangeStart('any', 1)).toBeUndefined();
  });
});
