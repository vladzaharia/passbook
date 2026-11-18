import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyToStatus } from './reply-to-status.tsx';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function show(state: 'pending' | 'confirmed' | 'none') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('reply-to')
        ? json({ address: state === 'none' ? null : 'help@harbor.test', state })
        : json({
            items: [
              {
                scope: 'org:o1',
                key: 'support.email',
                value: 'help@harbor.test',
                updatedAt: null,
                updatedBy: null,
              },
            ],
          }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReplyToStatus orgId="o1" />
    </QueryClientProvider>,
  );
}

describe('ReplyToStatus', () => {
  it('says it is waiting for confirmation and offers Resend', async () => {
    show('pending');
    expect(await screen.findByText(/Waiting for confirmation from help@harbor.test/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resend' })).toBeVisible();
  });
  it('says where replies go once confirmed, with no Resend', async () => {
    show('confirmed');
    expect(await screen.findByText('Replies go to help@harbor.test.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
  });
  it('renders nothing without a support address', async () => {
    const { container } = show('none');
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
