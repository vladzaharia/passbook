import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, problem } from '@/web/lib/test-utils.tsx';
import {
  CERT,
  cleanupWalletAccountsTest,
  fillGoogle,
  fillSamsung,
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

describe('wallet account credentials and readiness security', () => {
  it('confirms Samsung rotation and leaves the new credential unverified', async () => {
    const server = walletServer({
      initial: [
        ready('org-1', 'live', 'samsung', { accountId: 's1', revision: 4, state: 'configured' }),
      ],
    });
    mount();
    const user = userEvent.setup();
    const samsung = await screen.findByRole('region', { name: 'Samsung Wallet' });
    expect(await within(samsung).findByText('Not available yet')).toBeInTheDocument();
    await user.click(await within(samsung).findByRole('button', { name: 'Rotate credentials' }));
    let dialog = screen.getByRole('alertdialog', { name: 'Rotate Samsung Wallet credentials?' });
    expect(dialog).toHaveTextContent(/Replacement credentials take effect when saved/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(samsung).queryByLabelText(/^Partner ID/)).toBeNull();
    await user.click(within(samsung).getByRole('button', { name: 'Rotate credentials' }));
    dialog = screen.getByRole('alertdialog', { name: 'Rotate Samsung Wallet credentials?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fillSamsung(samsung);
    await user.click(within(samsung).getByRole('button', { name: 'Save replacement credentials' }));
    expect(await within(samsung).findByText('Configured')).toBeInTheDocument();
    expect(server.requests.find((request) => request.method === 'PUT')?.body).toEqual({
      orgId: 'org-1',
      mode: 'live',
      provider: 'samsung',
      expectedRevision: 4,
      credentials: {
        partnerId: 'partner_1',
        certificateId: 'AB12',
        cardId: 'card_1',
        partnerPrivateKeyPem: KEY,
        partnerCertificatePem: CERT,
        samsungCertificatePem: CERT,
      },
    });
    expect(within(samsung).queryByRole('button', { name: 'Record provider approval' })).toBeNull();
    expect(within(samsung).queryByRole('checkbox')).toBeNull();
  });

  it('keeps identifiers on local validation, clears private keys on send and never renders a server-reflected secret on failure', async () => {
    const server = walletServer({
      putError: problem(422, 'invalid_credentials', `Invalid ${KEY}`, [
        { path: 'credentials.privateKeyPem', message: KEY },
      ]),
    });
    const { client, container } = mount();
    const user = userEvent.setup();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(await within(google).findByRole('button', { name: 'Configure credentials' }));
    fillGoogle(google, 'bad key');
    await user.click(within(google).getByRole('button', { name: 'Save credentials' }));
    expect(within(google).getByText('Enter a PKCS#8 PRIVATE KEY PEM.')).toBeInTheDocument();
    expect(within(google).getByLabelText(/^Issuer ID/)).not.toHaveValue('');
    expect(
      within(google).getByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toHaveValue('bad key');
    expect(server.requests.some((request) => request.method === 'PUT')).toBe(false);
    fillGoogle(google);
    await user.click(within(google).getByRole('button', { name: 'Save credentials' }));
    expect(await within(google).findByText(/provider details were rejected/)).toBeInTheDocument();
    expect(
      within(google).getByLabelText(/^Service account private key \(PKCS#8 PEM\)/),
    ).toHaveValue('');
    expect(container.innerHTML).not.toContain(KEY_CONTENT);
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
  });

  it('rejects an obsolete approved account response rather than presenting readiness', async () => {
    const server = walletServer();
    server.fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/orgs/memberships/me') return json({ items: [membership()] });
      const provider = url.searchParams.get('provider') === 'samsung' ? 'samsung' : 'google';
      return json(
        provider === 'google'
          ? { ...ready('org-1', 'live', provider), state: 'approved' }
          : ready('org-1', 'live', provider),
      );
    });
    mount();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(
      await within(google).findByText('Could not complete the request. Try again.'),
    ).toBeInTheDocument();
    expect(within(google).queryByText(/approval verified|ready/i)).toBeNull();
    expect(within(google).queryByRole('button', { name: 'Configure credentials' })).toBeNull();
  });

  it('rejects a readiness response containing unexpected credential material', async () => {
    const server = walletServer();
    server.fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/orgs/memberships/me') return json({ items: [membership()] });
      const provider = url.searchParams.get('provider') === 'samsung' ? 'samsung' : 'google';
      return json({ ...ready('org-1', 'live', provider), privateKeyPem: KEY });
    });
    const { client, container } = mount();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(
      await within(google).findByText('Could not complete the request. Try again.'),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(KEY_CONTENT);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain(KEY_CONTENT);
    expect(within(google).queryByRole('button', { name: 'Configure credentials' })).toBeNull();
  });

  it('does not display readiness returned for a different scope and offers retry on errors', async () => {
    const server = walletServer({ initial: [ready('other-org', 'live', 'google')] });
    // A malformed response must not be mistaken for the requested organization.
    server.fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/orgs/memberships/me') return json({ items: [membership()] });
      if (url.searchParams.get('provider') === 'google')
        return json(ready('other-org', 'live', 'google'));
      return problem(503, 'unavailable', 'private detail');
    });
    mount();
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(
      await within(google).findByText('Could not complete the request. Try again.'),
    ).toBeInTheDocument();
    expect(within(google).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(google).queryByRole('button', { name: 'Configure credentials' })).toBeNull();
    expect(screen.queryByText('private detail')).toBeNull();
  });
});
