import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { problem } from '@/web/lib/test-utils.tsx';
import {
  cleanupWalletAccountsTest,
  fillGoogle,
  KEY,
  KEY_CONTENT,
  membership,
  mount,
  ready,
  setupWalletAccountsTest,
  walletServer,
} from './wallet-accounts-test-fixtures.ts';

beforeEach(setupWalletAccountsTest);
afterEach(cleanupWalletAccountsTest);

describe('organization wallet accounts', () => {
  it('shows redacted, explicitly unverified states and limits read-only membership', async () => {
    const server = walletServer({
      memberships: [membership('org-1', ['org:read', 'integrations:read'])],
      initial: [
        ready('org-1', 'live', 'google', {
          accountId: 'account-1',
          revision: 2,
          state: 'configured',
          updatedAt: 1_700_000_000_000,
        }),
      ],
    });
    const { container } = mount();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(await within(google).findByText('Configured')).toBeInTheDocument();
    expect(within(google).getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('Live', { selector: 'strong' })).toBeInTheDocument();
    expect(
      within(google).queryByRole('button', { name: /credentials|approval|revoke/i }),
    ).toBeNull();
    expect(
      await within(screen.getByRole('region', { name: 'Samsung Wallet' })).findByText(
        'Not configured',
      ),
    ).toBeInTheDocument();
    expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('does not assume platform administration or a different organization grants access', async () => {
    const server = walletServer({ memberships: [membership('org-2')] });
    mount();
    expect(
      await screen.findByText(/organization membership with wallet integration read access/),
    ).toBeInTheDocument();
    expect(server.requests).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Google Wallet' })).toBeNull();
  });

  it('allows an integration manager to configure and revoke without member-management access', async () => {
    const server = walletServer({
      memberships: [membership('org-1', ['org:read', 'integrations:read', 'integrations:manage'])],
      initial: [
        ready('org-1', 'live', 'google', { accountId: 'a1', revision: 1, state: 'configured' }),
      ],
    });
    mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(
      await within(google).findByRole('button', { name: 'Rotate credentials' }),
    ).toBeInTheDocument();
    expect(within(google).queryByRole('button', { name: 'Record provider approval' })).toBeNull();
    await user.click(within(google).getByRole('button', { name: 'Revoke account' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Google Wallet account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke account' }));
    expect(await within(google).findByText('Revoked')).toBeInTheDocument();
    expect(
      server.requests.find((request) => request.url.pathname.endsWith('/revoke'))?.body,
    ).toEqual({ orgId: 'org-1', mode: 'live', provider: 'google', expectedRevision: 1 });
  });

  it('keeps the open credential form and its values when the window regains focus', async () => {
    const server = walletServer();
    mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google);
    const reads = server.requests.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Checking organization access…')).toBeNull();
    expect(within(google).getByLabelText(/^Issuer ID/)).toHaveValue('123456');
    expect(server.requests.length).toBe(reads);
  });

  it('configures Google without caching secrets and confirms revocation', async () => {
    const server = walletServer();
    const { client, container } = mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google);
    await user.click(within(google).getByRole('button', { name: 'Save credentials' }));
    await waitFor(() =>
      expect(server.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    const put = server.requests.find((request) => request.method === 'PUT')!;
    expect(put.headers.get('x-passbook-mode')).toBe('live');
    expect(put.body).toEqual({
      orgId: 'org-1',
      mode: 'live',
      provider: 'google',
      expectedRevision: 0,
      credentials: {
        issuerId: '123456',
        serviceAccountEmail: 'wallet@project.iam.gserviceaccount.com',
        privateKeyPem: KEY,
        scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
      },
    });
    expect(await within(google).findByText('Configured')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(KEY_CONTENT);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain(KEY_CONTENT);
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain(KEY_CONTENT);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain('wallet@project.iam.gserviceaccount.com');
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain('123456');
    expect(within(google).queryByRole('button', { name: 'Record provider approval' })).toBeNull();
    expect(within(google).queryByRole('checkbox')).toBeNull();
    await waitFor(() =>
      expect(within(google).getByRole('button', { name: 'Revoke account' })).toBeEnabled(),
    );
    await user.click(within(google).getByRole('button', { name: 'Revoke account' }));
    let dialog = screen.getByRole('alertdialog', { name: 'Revoke Google Wallet account?' });
    expect(dialog).toHaveTextContent(/Copies already in a wallet are not removed/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.requests.some((request) => request.url.pathname.endsWith('/revoke'))).toBe(false);
    await user.click(within(google).getByRole('button', { name: 'Revoke account' }));
    dialog = screen.getByRole('alertdialog', { name: 'Revoke Google Wallet account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke account' }));
    expect(await within(google).findByText('Revoked')).toBeInTheDocument();
    expect(
      server.requests.find((request) => request.url.pathname.endsWith('/revoke'))?.body,
    ).toEqual({ orgId: 'org-1', mode: 'live', provider: 'google', expectedRevision: 1 });
    expect(within(google).queryByRole('button', { name: 'Record provider approval' })).toBeNull();
    expect(server.requests.some((request) => request.url.pathname.endsWith('/approve'))).toBe(
      false,
    );
  });

  it('explains that linked provider instances must be retired before account revocation', async () => {
    walletServer({
      initial: [
        ready('org-1', 'live', 'google', { accountId: 'g1', revision: 2, state: 'configured' }),
      ],
      revokeError: problem(409, 'WALLET_ACCOUNT_INSTANCES_ACTIVE', 'private provider detail'),
    });
    mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Revoke account' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Google Wallet account?' });
    expect(dialog).toHaveTextContent(/Retire linked wallet instances first/);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke account' }));
    expect(
      await within(dialog).findByText(
        /Revoke the provider objects and retire all linked wallet instances/,
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('private provider detail');
  });
});
