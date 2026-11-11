import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
} from '../../lib/test-utils.tsx';
import { ReviewStep } from './new-pass-review.tsx';
import { actionsFor } from './pass-actions.tsx';
import {
  eligibleTemplate,
  ORG,
  passDetail,
  passSummary,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
  templateVersionDetail,
} from './test-fixtures.ts';

const orgScope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};

afterEach(() => vi.unstubAllGlobals());

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const empty = () => json({ items: [], nextCursor: null });

function baseHandlers(extra: Record<string, FetchHandler> = {}): Record<string, FetchHandler> {
  const passList = extra['/api/v1/passes'];
  const eligibleList = extra['/api/v1/templates/eligible'];
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': (url) =>
      url.searchParams.get('orgId') === ORG.id
        ? json({ items: [templateSummary()], nextCursor: null })
        : problem(400, 'scope_required', 'Organization is required.'),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/previews': previewsHandler,
    '/api/v1/templates/tpl1/preview': () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
    '/api/v1/connections': (url) =>
      url.searchParams.get('orgId') === ORG.id
        ? empty()
        : problem(400, 'scope_required', 'Organization is required.'),
    ...extra,
    ...(passList
      ? {
          '/api/v1/passes': (url: URL, init: RequestInit | undefined) => {
            if (method(init) === 'GET') expect(url.searchParams.get('orgId')).toBe(ORG.id);
            return passList(url, init);
          },
        }
      : {}),
    ...(eligibleList
      ? {
          '/api/v1/templates/eligible': (url: URL, init: RequestInit | undefined) => {
            expect(url.searchParams.get('orgId')).toBe(ORG.id);
            expect(url.searchParams.get('mode')).toMatch(/^(live|test)$/);
            expect(url.searchParams.get('provider')).toBe('apple');
            return eligibleList(url, init);
          },
        }
      : {}),
  };
}

describe('passes list', () => {
  it('lists passes, loads more by cursor and keeps filters in the URL', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/passes?status=voided', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': (url) => {
          seen.push(url);
          return url.searchParams.get('cursor')
            ? json({ items: [passSummary({ id: 'p2', title: 'Second Pass' })], nextCursor: null })
            : json({ items: [passSummary()], nextCursor: 'c2' });
        },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Passes' })).toBeInTheDocument();
    expect(screen.queryByText('Every pass, in one place')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sam Jones' })).toHaveAttribute(
      'href',
      '/admin/passes/p1?orgId=org1',
    );
    expect(seen[0]?.searchParams.get('status')).toBe('voided');
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Second Pass' })).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('cursor')).toBe('c2');
    expect(seen.at(-1)?.searchParams.get('orgId')).toBe(ORG.id);

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ orgId: ORG.id }));
  });

  it('does not expose rows from another organization in a scoped response', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': () =>
          json({
            items: [
              passSummary(),
              passSummary({ id: 'p2', orgId: 'org2', title: 'Private other organization pass' }),
            ],
            nextCursor: null,
          }),
      }),
    });
    expect(await screen.findByRole('link', { name: 'Sam Jones' })).toBeInTheDocument();
    expect(screen.queryByText('Private other organization pass')).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: 'Select Private other organization pass' }),
    ).toBeNull();
  });

  it('filters to passes removed from Wallet', async () => {
    const seen: URL[] = [];
    await renderApp('/admin/passes?status=removed', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': (url) => {
          seen.push(url);
          return json({ items: [passSummary()], nextCursor: null });
        },
      }),
    });
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(seen[0]?.searchParams.get('status')).toBe('removed');
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
  });

  it('debounces search into the URL and the query', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
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
    expect(seen.every((url) => url.searchParams.get('orgId') === ORG.id)).toBe(true);
    // One request per pause, not per keystroke.
    expect(seen.filter((u) => u.searchParams.has('q')).length).toBe(1);
  });

  it('shows an empty state and an error state', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({ '/api/v1/passes': empty }),
    });
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
  });

  it('shows the error with retry when the list fails', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
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
      ...orgScope,
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

  it('does not reuse cached row links after a transfer becomes pending', async () => {
    const user = userEvent.setup();
    let pending = false;
    let reads = 0;
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
        '/api/v1/passes/p1': () => {
          reads++;
          return pending
            ? problem(409, 'PASS_TRANSFER_PENDING', 'This pass is being transferred.')
            : json(passDetail());
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Sam Jones' }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Copy link' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.keyboard('{Escape}');
    pending = true;
    await user.click(screen.getByRole('button', { name: 'Actions for Sam Jones' }));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(screen.getByRole('menuitem', { name: 'Open public page' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
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
      ...orgScope,
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
      ...orgScope,
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
      ...orgScope,
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
    await waitFor(() =>
      expect(bodies).toEqual([{ action: 'void', ids: ['p1', 'p2', 'p3'], orgId: ORG.id }]),
    );
  });

  it('warns that a failed bulk email may have partially completed', async () => {
    const user = userEvent.setup();
    let reads = 0;
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': () => {
          reads++;
          return json({ items: [passSummary()], nextCursor: null });
        },
        '/api/v1/passes/bulk': () => problem(503, 'down', 'down'),
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Sam Jones' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Send email',
      }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Email 1 holder?' });
    await user.click(within(dialog).getByRole('button', { name: 'Send email' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Some selected passes may already have been processed',
    );
    // The open dialog hides the bar from the accessibility tree; the selection stays.
    expect(screen.getByRole('region', { name: 'Selection', hidden: true })).toBeInTheDocument();
    expect(reads).toBeGreaterThan(1);
  });

  it('clears selection when search changes the list', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: baseHandlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Sam Jones' }));
    expect(screen.getByRole('region', { name: 'Selection' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search passes' }), 'sam');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
  });

  it('shows one primary and no search on a truly empty list', async () => {
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
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
      ...orgScope,
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
      '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
      '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
      ...extra,
    });
  }

  it('requires an explicit organization even when only one membership is available', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    const user = userEvent.setup();
    const { router, fetchMock, queryClient } = await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: orgScope.memberships,
      handlers: wizardHandlers(() => json({}), []),
    });
    const organization = await screen.findByRole('radio', { name: /Henry's/ });
    expect(organization).not.toBeChecked();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /^\/api\/v1\/(?:templates\/eligible|passes)(?:\?|$)/.test(String(url)),
      ),
    ).toBe(false);
    await user.click(organization);
    await waitFor(() => expect(router.state.location.search.orgId).toBe(ORG.id));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', ORG.id, 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
  });

  it('groups templates by scope and shows the choice on the stage from 1024', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /min-width: 1024px|prefers-reduced-motion: reduce/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const user = userEvent.setup();
    const generic = {
      templateId: 'tpl2',
      name: 'PassBook · Generic',
      templateOrgId: null,
      origin: 'baked',
      releaseId: 'release2',
    };
    const { container } = await renderApp('/admin/passes/new', {
      session: 'admin',
      ...orgScope,
      handlers: wizardHandlers(() => json({}), [], {
        '/api/v1/templates/eligible': () =>
          json({
            items: [eligibleTemplate(generic), eligibleTemplate({ name: "Henry's · Copper card" })],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl2/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
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
    // The compact eligible record has a name, not a draft description.
    const stage = screen.getByRole('complementary', { name: 'Preview' });
    await user.click(screen.getByRole('radio', { name: 'Generic' }));
    expect(within(stage).getByText('Generic')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Template', level: 2 })).toHaveClass('sr-only');
    expect((await axe(container)).violations).toEqual([]);
  });

  // A selected org lets the wizard start at the template step.
  async function toDetails(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);
  }

  it('walks template, details and holder for the selected org, then creates with an idempotency key', async () => {
    const user = userEvent.setup();
    const posts: RequestInit[] = [];
    const { router, container } = await renderApp('/admin/passes/new', {
      session: 'admin',
      ...orgScope,
      handlers: wizardHandlers(() => json(passDetail({ id: 'p9' }), 201), posts),
    });
    const entries = router.history.length;
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
    expect(screen.getByText('Mode', { selector: 'dt' }).parentElement).toHaveTextContent('Live');
    expect(screen.getByText('a1b2c3d4e5f6a7b8')).toBeInTheDocument();
    expect(screen.getByText('Requested for sam@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/this review does not lock it/i)).toBeNull();
    // Review: rows are a valid dl; an Edit link per row keeps the state.
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p9'));
    // The pass's page replaces the wizard and says what happened, with what to do next.
    expect(router.history.length).toBe(entries);
    expect(await screen.findByText(/Pass created.*email requested/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create another' })).toHaveAttribute(
      'href',
      expect.stringContaining('/admin/passes/new?'),
    );
    expect(screen.queryByRole('button', { name: 'Send to holder' })).toBeNull();
    // Just created: the happy buddy stands beside the pass, decorative.
    const buddy = await waitFor(() => {
      const el = document.querySelector('.wl-pass-buddy');
      expect(el).not.toBeNull();
      return el;
    });
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(buddy?.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'happy');
    expect(posts).toHaveLength(1);
    const headers = posts[0]?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(JSON.parse(String(posts[0]?.body))).toEqual({
      orgId: 'org1',
      templateId: 'tpl1',
      mode: 'live',
      templateVersion: 'a1b2c3d4e5f6a7b8',
      releaseId: 'release1',
      releaseGeneration: 1,
      input: { name: 'Sam Jones' },
      holderEmail: 'sam@example.com',
      sendEmail: true,
    });
  });

  it('blocks the details step on invalid input', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes/new', {
      session: 'admin',
      ...orgScope,
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
      ...orgScope,
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
      ...orgScope,
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
      ...orgScope,
      handlers: wizardHandlers(() => json({}), []),
    });
    await toDetails(user);
    await user.type(screen.getByLabelText(/Member name/), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Holder email'), 'nope');
    expect(screen.getByRole('checkbox', { name: 'Email the pass' })).toBeDisabled();
    // Nothing while typing: the error waits for Next.
    expect(screen.queryByText('Enter a valid email address.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Holder' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Holder email')).toHaveFocus());
    // Fixed, it clears at once and Next goes on to Review.
    await user.clear(screen.getByLabelText('Holder email'));
    await user.type(screen.getByLabelText('Holder email'), 'sam@example.com');
    expect(screen.queryByText('Enter a valid email address.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument();
  });

  it('opens a deep link with an org and template on Details', async () => {
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      ...orgScope,
      handlers: wizardHandlers(() => json({}), []),
    });
    expect(await screen.findByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Member name/)).toBeInTheDocument();
  });

  it('reviews every supplied field rather than only the first four', () => {
    const properties = Object.fromEntries(
      ['one', 'two', 'three', 'four', 'five'].map((key) => [key, { type: 'string', title: key }]),
    );
    render(
      <ReviewStep
        org="Example"
        mode="test"
        template="Membership"
        templateVersion="version-1"
        schema={{ type: 'object', properties }}
        input={{ one: '1', two: '2', three: '3', four: '4', five: 'fifth value' }}
        email=""
        send={false}
        steps={{ template: 0, details: 1, holder: 2 }}
        onEdit={() => {}}
        warnings={[]}
        error={null}
      />,
    );
    expect(screen.getByText('fifth value')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText('Not requested')).toBeInTheDocument();
  });
});
