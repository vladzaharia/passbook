import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture } from '@/web/lib/test-utils.tsx';
import { harbor, northwind, setup } from './scanner-api-test-fixtures.ts';
import { eligibleTemplateFixture } from './test-fixtures.ts';

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
  localStorage.removeItem('wallet-org-filter');
});

describe('useEligibleTemplates organization and mode scope', () => {
  it('does not request releases when no organization is supplied', async () => {
    const { requests } = setup(undefined, [northwind, harbor], 'eligible');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });

  it('does not request or expose another organization’s cached releases', async () => {
    const { requests } = setup('o2', [northwind, harbor], 'eligible');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached Harbor eligible')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('requires an organization, scanning:read, and template or pass read access', async () => {
    const noAccess = membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] });
    const { requests } = setup('o1', [noAccess], 'eligible');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });
  it('requires scanning:read even when template access is present', async () => {
    const noScanning = membershipFixture('o1', { capabilities: ['org:read', 'templates:read'] });
    const { requests } = setup('o1', [noScanning], 'eligible');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });

  it('accepts passes:read and includes shared but not foreign results', async () => {
    const member = membershipFixture('o1', {
      capabilities: ['org:read', 'scanning:read', 'passes:read'],
    });
    const { requests, eligibleRequests } = setup('o1', [member], 'eligible');
    expect(await screen.findByText(/Gala ticket/)).toBeInTheDocument();
    expect(screen.getByTestId('events')).toHaveTextContent('Shared ticket');
    expect(screen.getByTestId('events')).toHaveTextContent('Shared scoped ticket');
    expect(screen.queryByText(/Foreign ticket/)).not.toBeInTheDocument();
    expect(requests).toEqual(['o1']);
    expect(Object.fromEntries(eligibleRequests[0]!.searchParams)).toMatchObject({
      orgId: 'o1',
      mode: 'live',
      provider: 'apple',
    });
  });

  it('does not request releases when the resource mode differs from the console', async () => {
    const { requests } = setup('o1', [northwind, harbor], 'eligible', 'test');
    expect(await screen.findByTestId('events')).toHaveTextContent('No data');
    expect(requests).toEqual([]);
  });

  it('clears old-mode results until the new mode’s releases load', async () => {
    const { eligibleRequests, testMode } = setup('o1', [northwind, harbor], 'eligible');
    expect(await screen.findByText(/Gala ticket/)).toBeInTheDocument();
    act(() => setMode('test'));
    await waitFor(() =>
      expect(eligibleRequests.some((url) => url.searchParams.get('mode') === 'test')).toBe(true),
    );
    expect(screen.getByTestId('events')).toHaveTextContent('No data');
    expect(screen.queryByText(/Gala ticket/)).not.toBeInTheDocument();
    await act(async () => {
      testMode.resolve(
        json({ items: [eligibleTemplateFixture({ name: 'Test ticket' })], nextCursor: null }),
      );
    });
    expect(await screen.findByText('Test ticket')).toBeInTheDocument();
  });
});

describe('Event template choices', () => {
  it('offers approved owned and shared templates without detail fan-out', async () => {
    const { requests, eligibleRequests, detailRequests } = setup(
      'o1',
      [northwind, harbor],
      'choices',
    );
    expect(await screen.findByRole('checkbox', { name: 'Gala ticket' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Shared ticket' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Shared scoped ticket' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Value only/ })).toBeDisabled();
    expect(screen.queryByText('Foreign ticket')).not.toBeInTheDocument();
    expect(detailRequests).toEqual([]);
    expect(requests).toEqual(['o1']);
    expect(Object.fromEntries(eligibleRequests[0]!.searchParams)).toMatchObject({
      orgId: 'o1',
      mode: 'live',
      provider: 'apple',
    });
  });

  it('does not offer a cached release until it is revalidated', async () => {
    const { eligibleRequests, liveMode } = setup(
      'o1',
      [northwind, harbor],
      'choices',
      undefined,
      [],
      true,
    );
    await waitFor(() => expect(eligibleRequests).toHaveLength(1));
    expect(
      screen.queryByRole('checkbox', { name: 'Stale approved ticket' }),
    ).not.toBeInTheDocument();
    await act(async () => {
      liveMode.resolve(
        json({
          items: [eligibleTemplateFixture({ name: 'Fresh approved ticket' })],
          nextCursor: null,
        }),
      );
    });
    expect(
      await screen.findByRole('checkbox', { name: 'Fresh approved ticket' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Stale approved ticket')).not.toBeInTheDocument();
  });

  it('loads further eligible pages without fetching template details', async () => {
    const { eligibleRequests, detailRequests } = setup('o1', [northwind, harbor], 'choices');
    await screen.findByRole('checkbox', { name: 'Gala ticket' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more templates' }));
    expect(await screen.findByRole('checkbox', { name: 'Later ticket' })).toBeInTheDocument();
    expect(eligibleRequests[1]?.searchParams.get('cursor')).toBe('next');
    expect(detailRequests).toEqual([]);
  });

  it('lets an already-selected template without check-in be removed but not reselected', async () => {
    setup('o1', [northwind, harbor], 'choices', undefined, ['value']);
    const choice = await screen.findByRole('checkbox', { name: /Value only/ });
    expect(choice).toBeChecked();
    expect(choice).toBeEnabled();
    await userEvent.setup().click(choice);
    expect(choice).not.toBeChecked();
    expect(choice).toBeDisabled();
  });

  it('lets an existing unavailable selection be removed without offering it anew', async () => {
    setup('o1', [northwind, harbor], 'choices', undefined, ['retired-template']);
    const selected = await screen.findByRole('checkbox', {
      name: /no approved release/,
    });
    expect(selected).toBeChecked();
    await userEvent.setup().click(selected);
    expect(screen.queryByRole('checkbox', { name: /no approved release/ })).not.toBeInTheDocument();
  });

  it('explains that another organization must be selected instead of staying in a loading state', async () => {
    const { requests } = setup('o2', [northwind, harbor], 'choices');
    expect(await screen.findByText('Choose an organization first.')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('explains missing template access instead of staying in a loading state', async () => {
    const { requests } = setup(
      'o1',
      [membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] })],
      'choices',
    );
    expect(
      await screen.findByText('You do not have permission to view eligible templates.'),
    ).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});
