import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoveDialog } from './remove-dialog.tsx';

type Provider = 'google' | 'samsung';
let live: Provider[] = [];

// The status read is tested with its card; here only what the dialog says for the wallets it names.
vi.mock('./wallet-provider-status.tsx', () => ({
  useWalletProviderStatus: () => ({
    query: {
      data: {
        providers: (['google', 'samsung'] as const).map((provider) => ({
          provider,
          lifecycle: live.includes(provider) ? 'active' : 'absent',
          issuance: { state: 'enabled' },
        })),
      },
    },
  }),
}));

const show = (count = 1) =>
  render(
    <RemoveDialog
      open
      onOpenChange={() => undefined}
      count={count}
      pass={{ id: 'p1', orgId: 'o1', mode: 'live' }}
      onConfirm={async () => {}}
    />,
  );

beforeEach(() => {
  live = [];
});

describe('RemoveDialog by wallet', () => {
  it('states only the Apple effect when no other wallet holds the pass', () => {
    show();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Expired passes');
    expect(dialog).not.toHaveTextContent('Google');
    expect(dialog).not.toHaveTextContent('Samsung');
  });

  it('adds each live wallet its own effect, and no other', () => {
    live = ['google'];
    show();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Google Wallet marks it expired');
    expect(dialog).not.toHaveTextContent('Samsung');
    expect(dialog).toHaveTextContent('You can restore it later.');
  });
});
