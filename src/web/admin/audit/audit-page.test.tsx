import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { REDACTED } from './redact.ts';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: 1_700_000_000_000 + id,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  actorLabel: 'Ada Lovelace',
  action: 'pass.void',
  targetType: 'pass',
  targetId: `p${id}`,
  targetLabel: `Pass ${id}`,
  requestId: 'req-1',
  detail: null,
  ...over,
});
const page =
  (items: unknown[], nextCursor: string | null = null) =>
  () =>
    json({ items, nextCursor });

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}
const auditCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/v1/audit'));

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('audit page', () => {
  it('leads with the action label, links targets, keeps codes out of cells, accessible', async () => {
    const { container, fetchMock } = await renderApp('/admin/audit?action=pass.&from=100', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([entry(1)]) },
    });
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers[0]).toBe('Action');
    expect(headers.at(-1)).toBe('Time');
    expect(within(table).getByRole('button', { name: 'Pass voided' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Pass 1' })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    expect(within(table).getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
    expect(table.querySelectorAll('td .font-mono, td code')).toHaveLength(0);
    expect(within(table).queryByText('pass.void')).toBeNull();
    const call = auditCalls(fetchMock)[0];
    expect(call).toContain('action=pass.');
    expect(call).toContain('from=100');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reads the org scope', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'wallet-org-filter': 'o-north' }));
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([entry(1, { orgId: 'o-north' })]) },
    });
    await screen.findByRole('table', { name: 'Audit log' });
    expect(auditCalls(fetchMock)[0]).toContain('orgId=o-north');
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
  });

  it('filters with pickers and a date range, never raw id fields', async () => {
    const { router } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Filters/ }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).queryAllByRole('textbox')).toHaveLength(0);
    for (const name of ['User', 'Pass', 'Connection'])
      expect(
        within(popover).getByRole('combobox', { name: new RegExp(`^${name}`) }),
      ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Date: any' }));
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(router.state.location.search).toHaveProperty('from'));
  });

  it('filters by action label', async () => {
    const { router } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Action/ }));
    await user.click(await screen.findByRole('option', { name: 'Pass voided' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ action: 'pass.void' }),
    );
  });

  it('paginates with the cursor and opens the entry with its code', async () => {
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit': (url) =>
          url.searchParams.get('cursor') === 'c1'
            ? json({ items: [entry(2)], nextCursor: null })
            : json({ items: [entry(1)], nextCursor: 'c1' }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Pass 2' })).toBeInTheDocument();
    expect(auditCalls(fetchMock).some((u) => u.includes('cursor=c1'))).toBe(true);
    await user.click(screen.getAllByRole('button', { name: 'Pass voided' })[0] as HTMLElement);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('pass.void')).toHaveClass('font-mono', 'text-xs');
  });

  it('redacts secrets in the entry detail', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit': page([
          entry(1, {
            detail: { before: { name: 'A', apiKey: 'hunter2' }, after: { name: 'B', apiKey: 'x' } },
          }),
        ]),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Pass voided' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    expect(drawer.textContent).not.toContain('hunter');
    expect(drawer.textContent).toContain(REDACTED);
  });

  it('shows the log art when empty and the lens when filtered', async () => {
    const empty = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([]) },
    });
    expect(await screen.findByText('No entries')).toBeInTheDocument();
    expect(empty.container.querySelector('[data-art="log"]')).not.toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
    empty.unmount();
    const filtered = await renderApp('/admin/audit?actorId=u9', {
      session: 'admin',
      handlers: { '/api/v1/audit': page([]) },
    });
    expect(await screen.findByText('No entries match')).toBeInTheDocument();
    expect(filtered.container.querySelector('[data-art="lens-overlay"]')).not.toBeNull();
  });

  it('shows an error', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
  });

  it('stacks rows below 768 with action, actor and target', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((media: string) => ({
      matches: media.includes('max-width: 767') || media.includes('prefers-reduced-motion'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof matchMedia;
    try {
      await renderApp('/admin/audit', {
        session: 'admin',
        handlers: { '/api/v1/audit': page([entry(1)]) },
      });
      const list = await screen.findByRole('list', { name: 'Audit log' });
      const row = within(list).getAllByRole('listitem')[0] as HTMLElement;
      expect(within(row).getByRole('button', { name: 'Pass voided' })).toBeInTheDocument();
      expect(within(row).getByText('Ada Lovelace')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: 'Pass 1' })).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
