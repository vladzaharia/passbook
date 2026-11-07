import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { json, problem, sessionFixture, stubFetch } from '../../lib/test-utils.tsx';
import { ScanApp } from '../scan-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});
function setup(role: 'anon' | 'user' | 'admin', direct = false) {
  history.replaceState(null, '', direct ? '/scan?admin=1' : '/scan');
  let identity = sessionFixture(role);
  const fetch = stubFetch({
    '/api/v1/session': () => json(identity),
    '/api/v1/scan/session': () => problem(401, 'SCANNER_UNAUTHENTICATED', 'Pair this scanner.'),
    '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <CoreProviders queryClient={client}>
      <ScanApp />
    </CoreProviders>,
  );
  return {
    fetch,
    client,
    signOut: () => {
      identity = sessionFixture('anon');
    },
  };
}
describe('admin scanner entry', () => {
  it.each(['anon', 'user'] as const)(
    'hides admin entry for %s, including direct admin URLs',
    async (role) => {
      const { fetch } = setup(role, true);
      await screen.findByTestId('scan-pair');
      expect(screen.queryByRole('button', { name: 'Scan as Admin' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Scan as Admin' })).not.toBeInTheDocument();
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/orgs'))).toBe(false);
    },
  );
  it('offers the alternative only to a signed-in admin and removes it on sign-out', async () => {
    const user = userEvent.setup();
    const s = setup('admin');
    await user.click(await screen.findByRole('button', { name: 'Scan as Admin' }));
    await screen.findByRole('heading', { name: 'Scan as Admin' });
    s.signOut();
    await s.client.invalidateQueries({ queryKey: ['scan', 'platform-session'] });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Scan as Admin' })).not.toBeInTheDocument(),
    );
    await screen.findByTestId('scan-pair');
  });
});
