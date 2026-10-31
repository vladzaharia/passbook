import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, problem, renderApp } from '../../lib/test-utils.tsx';
import {
  ORG,
  passDetail,
  passSummary,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const empty = () => json({ items: [], nextCursor: null });

function baseHandlers(extra: Record<string, FetchHandler> = {}): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/tpl1/preview': () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a' }),
    '/api/v1/connections': empty,
    ...extra,
  };
}

describe('passes list', () => {
  it('lists passes, loads more by cursor and keeps filters in the URL', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/passes?status=voided', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': (url) => {
          seen.push(url);
          return url.searchParams.get('cursor')
            ? json({ items: [passSummary({ id: 'p2', title: 'Second Pass' })], nextCursor: null })
            : json({ items: [passSummary()], nextCursor: 'c2' });
        },
      }),
    });
    expect(await screen.findByRole('link', { name: 'Sam Jones' })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    expect(seen[0]?.searchParams.get('status')).toBe('voided');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Second Pass' })).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('cursor')).toBe('c2');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('debounces search into the URL and the query', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': (url) => {
          seen.push(url);
          return json({ items: [], nextCursor: null });
        },
      }),
    });
    await user.type(await screen.findByRole('searchbox', { name: 'Search passes' }), 'sam');
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe('sam'));
    await waitFor(() => expect(seen.some((u) => u.searchParams.get('q') === 'sam')).toBe(true));
    // One request per pause, not per keystroke.
    expect(seen.filter((u) => u.searchParams.has('q')).length).toBe(1);
  });

  it('shows an empty state and an error state', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({ '/api/v1/passes': empty }),
    });
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
  });

  it('shows the error with retry when the list fails', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': () => problem(500, 'boom', 'internal'),
      }),
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('voids from the row menu', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
        '/api/v1/passes/p1/void': (_u, init) => {
          calls.push(method(init));
          return json(passSummary({ status: 'voided' }));
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Sam Jones' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Void' }));
    await waitFor(() => expect(calls).toEqual(['POST']));
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
      }),
    });
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('new pass wizard', () => {
  function wizardHandlers(
    onPost: (init: RequestInit | undefined) => Response,
    posts: RequestInit[],
  ) {
    return baseHandlers({
      '/api/v1/passes': (_u, init) => {
        if (method(init) === 'POST') {
          posts.push(init as RequestInit);
          return onPost(init);
        }
        return json({ items: [], nextCursor: null });
      },
      '/api/v1/passes/p9': () =>
        json(passDetail({ id: 'p9', serial: 'SER-009', title: 'Created Pass' })),
    });
  }

  async function toDetails(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /Henry's/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);
  }

  it('walks org, template, details and holder, then creates with an idempotency key', async () => {
    const user = userEvent.setup();
    const posts: RequestInit[] = [];
    const { router } = await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => json(passDetail({ id: 'p9' }), 201), posts),
    });
    // Next stays disabled until an org is chosen.
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    await toDetails(user);
    await user.type(screen.getByLabelText(/Member name/), 'Sam Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Holder email'), 'sam@example.com');
    await user.click(screen.getByRole('switch', { name: 'Email the pass to the holder' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create pass' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p9'));
    expect(posts).toHaveLength(1);
    const headers = posts[0]?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(JSON.parse(String(posts[0]?.body))).toEqual({
      orgId: 'org1',
      templateId: 'tpl1',
      input: { name: 'Sam Jones' },
      holderEmail: 'sam@example.com',
      sendEmail: true,
    });
  });

  it('blocks the details step on invalid input', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => json({}), []),
    });
    await toDetails(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Required.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Member name/)).toBeInTheDocument();
  });

  it('reuses the idempotency key when the same create is retried', async () => {
    const user = userEvent.setup();
    const posts: RequestInit[] = [];
    let n = 0;
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(
        () => (++n === 1 ? problem(503, 'down', 'down') : json(passDetail({ id: 'p9' }), 201)),
        posts,
      ),
    });
    await toDetails(user);
    await user.type(screen.getByLabelText(/Member name/), 'Sam Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create pass' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
    await user.click(screen.getByRole('button', { name: 'Create pass' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    const keys = posts.map((p) => (p.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('sends a new key after the payload changes', async () => {
    const user = userEvent.setup();
    const posts: RequestInit[] = [];
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => problem(503, 'down', 'down'), posts),
    });
    await toDetails(user);
    await user.type(screen.getByLabelText(/Member name/), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create pass' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.type(screen.getByLabelText(/Member name/), ' Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create pass' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    const keys = posts.map((p) => (p.headers as Record<string, string>)['idempotency-key']);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('rejects an invalid holder email before the review step', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => json({}), []),
    });
    await toDetails(user);
    await user.type(screen.getByLabelText(/Member name/), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Holder email'), 'nope');
    expect(screen.getByRole('switch', { name: 'Email the pass to the holder' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Steps' })).getByText(/4\. Holder/),
    ).toHaveAttribute('aria-current', 'step');
  });
});
