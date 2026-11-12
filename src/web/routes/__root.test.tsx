import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionQuery } from '../lib/session.ts';
import { json, renderApp, sessionFixture, stubFetch } from '../lib/test-utils.tsx';
import { PrincipalBoundary } from './__root.tsx';

afterEach(() => vi.unstubAllGlobals());

function DraftProbe({ page }: { page: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [seed] = useState(() => client.getQueryData<string>(['probe', 'seed']) ?? 'No prior seed');
  const query = useQuery({
    queryKey: ['probe', 'detail'],
    queryFn: async () => 'Fetched detail',
    initialData: seed,
    staleTime: Infinity,
  });
  return (
    <>
      <p>{page}</p>
      <label htmlFor="principal-draft">Draft</label>
      <input
        id="principal-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p data-testid="principal-seed">{seed}</p>
      <p data-testid="principal-detail">{query.data}</p>
    </>
  );
}

function setupProbe(kind: 'user' | 'anon' = 'user') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, sessionFixture(kind));
  client.setQueryData(['probe', 'seed'], 'Previous principal secret');
  const tree = (page: string) => (
    <QueryClientProvider client={client}>
      <PrincipalBoundary>
        <DraftProbe page={page} />
      </PrincipalBoundary>
    </QueryClientProvider>
  );
  const view = render(tree('First view'));
  return { client, tree, ...view };
}

describe('principal boundary', () => {
  it('discards component state and query initialData when the authenticated user changes', async () => {
    const user = userEvent.setup();
    const { client } = setupProbe();
    await user.type(screen.getByLabelText('Draft'), 'Unsaved draft');
    expect(screen.getByTestId('principal-detail')).toHaveTextContent('Previous principal secret');
    const previous = sessionFixture('user');
    if (!previous.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...previous, user: { ...previous.user, id: 'u2' } }),
    });

    await act(async () => {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(client.getQueryData(sessionQuery.queryKey)).toMatchObject({
      authenticated: true,
      user: { id: 'u2' },
    });
    await waitFor(() => expect(screen.getByLabelText('Draft')).toHaveValue(''));
    expect(screen.getByTestId('principal-seed')).toHaveTextContent('No prior seed');
    expect(screen.getByTestId('principal-detail')).toHaveTextContent('No prior seed');
    expect(client.getQueryData(['probe', 'seed'])).toBeUndefined();
  });

  it.each([
    ['anon', 'user'],
    ['user', 'anon'],
  ] as const)(
    'discards local state when authentication changes from %s to %s',
    async (before, after) => {
      const user = userEvent.setup();
      const { client } = setupProbe(before);
      await user.type(screen.getByLabelText('Draft'), 'Unsaved draft');
      stubFetch({ '/api/v1/session': () => json(sessionFixture(after)) });

      await act(async () => {
        await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      });
      expect(client.getQueryData(sessionQuery.queryKey)).toEqual(sessionFixture(after));
      await waitFor(() => expect(screen.getByLabelText('Draft')).toHaveValue(''));
      expect(screen.getByTestId('principal-detail')).toHaveTextContent('No prior seed');
    },
  );

  it('keeps drafts and seeded data on navigation and same-user session refresh', async () => {
    const user = userEvent.setup();
    const { client, rerender, tree } = setupProbe();
    await user.type(screen.getByLabelText('Draft'), 'Unsaved draft');
    rerender(tree('Second view'));
    expect(screen.getByText('Second view')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft')).toHaveValue('Unsaved draft');
    // The fixture changes roles but keeps the same authenticated user ID.
    stubFetch({ '/api/v1/session': () => json(sessionFixture('admin')) });

    await act(async () => {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(screen.getByLabelText('Draft')).toHaveValue('Unsaved draft');
    expect(screen.getByTestId('principal-detail')).toHaveTextContent('Previous principal secret');
  });

  it('remounts the real account route on user change but not a same-user refresh', async () => {
    const user = userEvent.setup();
    const first = sessionFixture('user');
    if (!first.authenticated) throw new Error('Expected an authenticated fixture');
    let current = first;
    const { queryClient, router } = await renderApp('/account', {
      handlers: {
        '/api/v1/session': () => json(current),
        '/api/v1/me/emails': () =>
          json({
            items: [
              { email: 'test@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: true },
            ],
          }),
        '/api/v1/me/sessions': () => json({ items: [] }),
      },
    });
    await user.type(await screen.findByLabelText('Add email'), 'draft@example.com');

    await act(async () => {
      await router.navigate({ to: '/account', search: { add: 'email' } });
    });
    expect(screen.getByLabelText('Add email')).toHaveValue('draft@example.com');

    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(screen.getByLabelText('Add email')).toHaveValue('draft@example.com');

    current = { ...first, user: { ...first.user, id: 'u2', name: 'Second User' } };
    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(await screen.findByText('Second User')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Add email')).toHaveValue(''));
  });
});
