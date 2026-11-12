import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { membershipFixture } from '@/web/lib/test-utils.tsx';
import { harbor, northwind, setup } from './scanner-api-test-fixtures.ts';

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
  localStorage.removeItem('wallet-org-filter');
});

describe('useScanEvents organization scope', () => {
  it('does not request events without an organization', async () => {
    const { requests } = setup(undefined);
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });

  it('does not request or return a cached other-organization event', async () => {
    const { requests } = setup('o2');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached Harbor event')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('does not fetch a different organization even when explicitly refreshed', async () => {
    const { requests } = setup('o2');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Refresh events' }));
    await waitFor(() =>
      expect(screen.getByTestId('query-error')).toHaveTextContent(
        'Choose an authorized organization.',
      ),
    );
    expect(requests).toEqual([]);
  });

  it('does not request events without the selected membership scanning:read capability', async () => {
    const { requests } = setup('o1', [membershipFixture('o1', { capabilities: ['org:read'] })]);
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });
  it('removes cached event data if scanning read access is revoked', async () => {
    const { queryClient, requests } = setup('o1');
    expect(await screen.findByText('Northwind event')).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...northwind, capabilities: ['org:read'] }, harbor],
      });
    });
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('No data'));
    expect(screen.queryByText('Northwind event')).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
  });

  it('loads only the selected organization and clears data when the scope changes', async () => {
    const { router, requests } = setup('o1');
    expect(await screen.findByText('Northwind event')).toBeInTheDocument();
    expect(screen.queryByText(/Foreign event/)).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
    });
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('No data'));
    expect(screen.queryByText('Northwind event')).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
  });
});

describe('useOrgTemplates organization scope', () => {
  it('does not expose legacy unscoped cache when no organization is supplied', async () => {
    const { requests } = setup(undefined, [northwind, harbor], 'templates');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached unscoped template')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('does not request templates without a selected matching organization', async () => {
    const { requests } = setup('o2', [northwind, harbor], 'templates');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached Harbor template')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('does not fetch a different organization even when explicitly refreshed', async () => {
    const { requests } = setup('o2', [northwind, harbor], 'templates');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Refresh templates' }));
    await waitFor(() =>
      expect(screen.getByTestId('query-error')).toHaveTextContent(
        'Choose an authorized organization.',
      ),
    );
    expect(requests).toEqual([]);
  });

  it('does not request templates without templates:read', async () => {
    const { requests } = setup(
      'o1',
      [membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] })],
      'templates',
    );
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });

  it('loads selected templates and clears the result on an organization switch', async () => {
    const { router, requests } = setup('o1', [northwind, harbor], 'templates');
    expect(await screen.findByText(/Gala ticket/)).toBeInTheDocument();
    expect(screen.getByTestId('events')).toHaveTextContent('Shared ticket');
    expect(screen.queryByText(/Foreign ticket/)).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
    });
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('No data'));
    expect(screen.queryByText(/Gala ticket/)).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
  });
});
