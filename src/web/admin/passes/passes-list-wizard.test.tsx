import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, problem, renderApp } from '../../lib/test-utils.tsx';
import { actionsFor } from './pass-actions.tsx';
import {
  ORG,
  passDetail,
  passSummary,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const empty = () => json({ items: [], nextCursor: null });

function baseHandlers(extra: Record<string, FetchHandler> = {}): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/previews': previewsHandler,
    '/api/v1/templates/tpl1/preview': () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
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
          return json({ items: [passSummary()], nextCursor: null });
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
    // The row uses the header's guard: nothing is sent until the confirm.
    const ask = await screen.findByRole('alertdialog', { name: 'Void pass?' });
    expect(calls).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls).toEqual(['POST']));
  });

  it('offers the same actions in the row menu as in the detail header', async () => {
    const user = userEvent.setup();
    const pass = passDetail();
    const expected = actionsFor(pass as Parameters<typeof actionsFor>[0]).map((a) => a.label);
    const labels = async () =>
      (await screen.findAllByRole('menuitem')).map((m) => m.textContent?.trim() ?? '');
    // The detail header: the bar buttons plus More.
    const detail = await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: baseHandlers({ '/api/v1/passes/p1': () => json(pass) }),
    });
    const bar = [
      await screen.findByRole('button', { name: 'Update devices' }),
      screen.getByRole('button', { name: 'Void' }),
      screen.getByRole('link', { name: 'Open public page' }),
    ].map((el) => el.textContent?.trim() ?? '');
    await user.click(screen.getByRole('button', { name: 'More' }));
    const header = [...bar, ...(await labels())];
    detail.unmount();
    document.body.innerHTML = '';
    // The row menu on the list.
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
        '/api/v1/passes/p1': () => json(pass),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Sam Jones' }));
    const row = await labels();
    expect(new Set(row)).toEqual(new Set(expected));
    expect(new Set(header)).toEqual(new Set(expected));
  });

  it('selects rows, voids them in bulk after a counted confirm and exports a CSV', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const three = ['p1', 'p2', 'p3'].map((id, i) =>
      passSummary({ id, title: `Pass ${i + 1}`, serial: `S-${i}` }),
    );
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({
        '/api/v1/passes': () =>
          json({ items: [...three, passSummary({ id: 'p4', title: 'Other' })], nextCursor: null }),
        '/api/v1/passes/bulk': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ done: 3, skipped: [] });
        },
      }),
    });
    for (const n of [1, 2, 3])
      await user.click(await screen.findByRole('checkbox', { name: `Select Pass ${n}` }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Void' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Void 3 passes?' });
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(bodies).toEqual([{ action: 'void', ids: ['p1', 'p2', 'p3'] }]));
  });

  it('shows one primary and no search on a truly empty list', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      handlers: baseHandlers({ '/api/v1/passes': empty }),
    });
    await screen.findByText('No passes yet');
    expect(screen.queryByRole('searchbox')).toBeNull();
    const creates = screen.getAllByRole('link', { name: 'New pass' });
    expect(creates).toHaveLength(2);
    // The header turns outline; the empty state holds the only primary.
    expect(creates.filter((a) => a.className.includes('bg-accent'))).toHaveLength(1);
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
    extra: Record<string, FetchHandler> = {},
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
      ...extra,
    });
  }

  it('groups templates by scope and shows the choice on the stage from 1024', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /min-width: 1024px|prefers-reduced-motion: reduce/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const user = userEvent.setup();
    const generic = {
      id: 'tpl2',
      name: 'PassBook · Generic',
      orgId: null,
      orgName: null,
      description: 'Membership card.',
    };
    const { container } = await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => json({}), [], {
        '/api/v1/templates': () =>
          json({
            items: [templateSummary(generic), templateSummary({ name: "Henry's · Copper card" })],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl2': () => json(templateDetail(generic)),
        '/api/v1/templates/tpl2/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
      }),
    });
    await screen.findByRole('radio', { name: 'Copper card' });
    // The org's own first, then Shared; names lose the prefix their group repeats.
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.querySelector('legend')?.textContent)).toEqual([
      "Henry's",
      'Shared',
    ]);
    expect(within(groups[1] as HTMLElement).getByRole('radio', { name: 'Generic' })).toBeVisible();
    expect(screen.queryByText('PassBook · Generic')).toBeNull();
    // The stage carries the description, so the tile does not.
    const stage = screen.getByRole('complementary', { name: 'Preview' });
    await user.click(screen.getByRole('radio', { name: 'Generic' }));
    expect(within(stage).getByText('Generic')).toBeInTheDocument();
    expect(screen.getAllByText('Membership card.')).toHaveLength(1);
    expect(within(stage).getByText('Membership card.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Template', level: 2 })).toHaveClass('sr-only');
    expect((await axe(container)).violations).toEqual([]);
  });

  // One active org: the wizard skips the Organization step.
  async function toDetails(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);
  }

  it('walks org, template, details and holder, then creates with an idempotency key', async () => {
    const user = userEvent.setup();
    const posts: RequestInit[] = [];
    const { router, container } = await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: wizardHandlers(() => json(passDetail({ id: 'p9' }), 201), posts),
    });
    // Without a template, Next stays on the Template step, says why and focuses the first tile.
    // Wait for the tiles: before they load there is nothing to focus.
    await screen.findByRole('radio', { name: /Copper card/ });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Template' })).toBeInTheDocument();
    expect(screen.getByText('Choose a template.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('radio')[0]));
    expect(await screen.findByText('1 field needs attention')).toBeInTheDocument();
    await toDetails(user);
    // Details with a required field empty: focus moves to it.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Member name/)));
    await user.type(screen.getByLabelText(/Member name/), 'Sam Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Holder email'), 'sam@example.com');
    // A valid address checks the box by itself.
    expect(
      screen.getByRole('checkbox', { name: 'Email the pass to sam@example.com' }),
    ).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Review: rows are a valid dl; an Edit link per row keeps the state.
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));

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
    expect(screen.getByRole('checkbox', { name: 'Email the pass' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Holder' })).toBeInTheDocument();
  });

  it('opens a deep link with an org and template on Details', async () => {
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      handlers: wizardHandlers(() => json({}), []),
    });
    expect(await screen.findByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Member name/)).toBeInTheDocument();
  });
});
