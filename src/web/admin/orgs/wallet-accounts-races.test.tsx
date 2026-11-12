import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCsrfProvider } from '@/web/lib/api.ts';
import { setMode } from '@/web/lib/mode.ts';
import { WalletAccountsPanel } from './wallet-accounts.tsx';
import {
  cleanupWalletAccountsTest,
  fillGoogle,
  membership,
  mount,
  ready,
  setupWalletAccountsTest,
  walletServer,
} from './wallet-accounts-test-fixtures.ts';

beforeEach(setupWalletAccountsTest);
afterEach(cleanupWalletAccountsTest);

describe('wallet account scope and access races', () => {
  it('clears private keys immediately while a request is pending and keeps mode and organization scoped', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T) => void;
        reject: (reason: unknown) => void;
      };
    };
    const { promise: holdPut, resolve: release } = deferred.withResolvers<void>();
    const server = walletServer({
      memberships: [membership('org-1'), membership('org-2')],
      holdPut,
      initial: [
        ready('org-1', 'test', 'google', {
          accountId: 'test-account',
          revision: 8,
          state: 'revoked',
        }),
      ],
    });
    const view = mount();
    const user = userEvent.setup();
    let google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google);
    await user.click(within(google).getByRole('button', { name: 'Save credentials' }));
    await waitFor(() =>
      expect(server.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    expect(
      within(google).getByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toHaveValue('');
    expect(within(google).getByLabelText(/^Issuer ID/)).not.toHaveValue('');
    act(() => setMode('test'));
    google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(await within(google).findByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('Test', { selector: 'strong' })).toBeInTheDocument();
    expect(
      within(google).queryByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toBeNull();
    const write = server.requests.find((request) => request.method === 'PUT')!;
    expect(write.body).toMatchObject({ orgId: 'org-1', mode: 'live', provider: 'google' });
    expect(write.headers.get('x-passbook-mode')).toBe('live');
    expect(
      server.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.url.searchParams.get('mode') === 'test' &&
          request.headers.get('x-passbook-mode') === 'test',
      ),
    ).toBe(true);
    await act(async () => {
      release(undefined);
      await holdPut;
    });
    view.rerender(<WalletAccountsPanel orgId="org-2" />);
    google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(await within(google).findByText('Not configured')).toBeInTheDocument();
    expect(
      server.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.url.searchParams.get('orgId') === 'org-2' &&
          request.url.searchParams.get('mode') === 'test',
      ),
    ).toBe(true);
  });

  it('pins a write to its original mode while CSRF acquisition is pending', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T) => void;
        reject: (reason: unknown) => void;
      };
    };
    const csrf = deferred.withResolvers<string | undefined>();
    setCsrfProvider(() => csrf.promise);
    const server = walletServer();
    mount();
    const user = userEvent.setup();
    let google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google);
    await user.click(within(google).getByRole('button', { name: 'Save credentials' }));
    expect(
      within(google).getByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toHaveValue('');
    expect(server.requests.some((request) => request.method === 'PUT')).toBe(false);
    act(() => setMode('test'));
    google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(await within(google).findByText('Not configured')).toBeInTheDocument();
    await act(async () => {
      csrf.resolve('csrf-test');
      await csrf.promise;
    });
    await waitFor(() =>
      expect(server.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    const write = server.requests.find((request) => request.method === 'PUT')!;
    expect(write.headers.get('x-passbook-mode')).toBe('live');
    expect(write.headers.get('x-csrf-token')).toBe('csrf-test');
    expect(write.body).toMatchObject({ orgId: 'org-1', mode: 'live', provider: 'google' });
  });

  it('invalidates an open revocation confirmation when the account revision changes', async () => {
    const server = walletServer({
      initial: [
        ready('org-1', 'live', 'google', { accountId: 'g1', revision: 1, state: 'configured' }),
      ],
    });
    const { client } = mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Revoke account' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Google Wallet account?' });
    server.records.set(
      'org-1:live:google',
      ready('org-1', 'live', 'google', { accountId: 'g1', revision: 2, state: 'configured' }),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['wallet-accounts', 'org-1', 'live', 'google'] });
    });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Revoke account' })).toBeDisabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('removes edit controls if refreshed membership loses its management capability', async () => {
    const memberships = [membership()];
    walletServer({ memberships });
    const { client } = mount();
    const user = userEvent.setup();
    let google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google);
    memberships.splice(0, 1, membership('org-1', ['org:read', 'integrations:read']));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['wallet-accounts-access', 'org-1', 'live'] });
    });
    google = await screen.findByRole('region', { name: 'Google Wallet' });
    await within(google).findByText('Not configured');
    expect(
      within(google).queryByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toBeNull();
    expect(within(google).queryByRole('button', { name: 'Configure credentials' })).toBeNull();
  });
});
