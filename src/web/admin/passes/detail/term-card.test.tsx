import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassTermDto } from '@/shared/contracts/pass-term.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { createQueryClient } from '../../../lib/query-client.ts';
import { membershipsQuery, sessionQuery } from '../../../lib/session.ts';
import {
  json,
  membershipFixture,
  problem,
  sessionFixture,
  stubFetch,
} from '../../../lib/test-utils.tsx';
import { TooltipProvider, toast } from '../../../ui/index.ts';
import { passDetail } from '../test-fixtures.ts';
import { TermCard } from './term-card.tsx';

afterEach(() => {
  resetModeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const term = (over: Partial<PassTermDto> = {}): PassTermDto => ({
  input: 'term_start',
  end: '2031-03-15T10:00:00Z',
  ...over,
});

function setup(current: PassTermDto, readOnly = false) {
  const client = createQueryClient();
  const session = sessionFixture('admin');
  if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
  client.setQueryData(sessionQuery.queryKey, session);
  client.setQueryData(membershipsQuery.queryKey, {
    items: [
      membershipFixture('org1', {
        userId: session.user.id,
        capabilities: ['org:read', 'passes:read', 'passes:operate'],
      }),
    ],
  });
  const pass = passDetail({ term: current, mode: 'live' }) as unknown as PassDetailDto;
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <TermCard pass={pass} term={current} readOnly={readOnly} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, pass };
}

describe('Term card', () => {
  it('shows the end and offers a renewal', async () => {
    const { container } = setup(term());
    expect(screen.getByText(/^Ends /)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeEnabled();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renews through the pass API', async () => {
    const fetch = stubFetch({
      '/api/v1/passes/p1/renew': () =>
        json(passDetail({ term: term({ end: '2032-03-15T10:00:00Z' }) })),
    });
    const done = vi.spyOn(toast, 'success');
    setup(term());
    await userEvent.click(screen.getByRole('button', { name: 'Renew' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(done).toHaveBeenCalledWith('Term renewed'));
  });

  it('waits for the first scan, and shows a refusal', async () => {
    setup(term({ end: null }));
    expect(screen.getByText('Not started.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeDisabled();
  });

  it('shows the server refusal', async () => {
    stubFetch({
      '/api/v1/passes/p1/renew': () => problem(409, 'TERM_MANAGED', 'A connection sets the start.'),
    });
    setup(term());
    await userEvent.click(screen.getByRole('button', { name: 'Renew' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A connection sets the start.');
  });

  it('is inert when the pass is read only', () => {
    setup(term(), true);
    expect(screen.getByRole('button', { name: 'Renew' })).toBeDisabled();
  });
});
