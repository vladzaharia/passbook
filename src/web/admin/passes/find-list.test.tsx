import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FILTER_RUN_MAX } from '@/shared/contracts/pass-selection.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  ORG,
  passSummary,
  previewsHandler,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const orgScope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};
const empty = () => json({ items: [], nextCursor: null });

function handlers(extra: Record<string, (url: URL, init?: RequestInit) => Response>) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/templates/previews': previewsHandler,
    '/api/v1/connections': empty,
    '/api/v1/passes/views': () => json({ items: [] }),
    ...extra,
  };
}

describe('find passes', () => {
  it('asks the API for a text chip as a match, with a count', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': (url) => {
          seen.push(url);
          return json({ items: [passSummary()], nextCursor: null, count: 1 });
        },
      }),
    });
    await user.type(await screen.findByRole('combobox', { name: 'Find passes' }), 'sam');
    await user.click(await screen.findByRole('option', { name: /in any field/ }));
    expect(await screen.findByRole('button', { name: /^Remove Any field/ })).toBeInTheDocument();
    await waitFor(() => expect(seen.some((u) => u.searchParams.get('q') === 'sam')).toBe(true));
    expect(seen.every((u) => u.searchParams.get('count') === 'true')).toBe(true);
  });

  it('selects all matching and voids by filter with the count it saw', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const rows = ['p1', 'p2'].map((id, i) => passSummary({ id, title: `Pass ${i + 1}` }));
    await renderApp('/admin/passes?status=active', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': () => json({ items: rows, nextCursor: 'c', count: 40 }),
        '/api/v1/passes/bulk': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ done: 40, skipped: [] });
        },
      }),
    });
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select all passes on this page' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Select all 40 matching' }));
    expect(await screen.findByText('All 40 matching selected')).toBeInTheDocument();
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('40 selected')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    await user.click(within(bar).getByRole('button', { name: 'Void' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Void 40 passes?' });
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        {
          action: 'void',
          selection: { filter: { status: 'active' }, expectCount: 40 },
          orgId: ORG.id,
        },
      ]),
    );
  });

  it('asks to narrow when more match than one request can act on', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': () =>
          json({ items: [passSummary()], nextCursor: 'c', count: FILTER_RUN_MAX + 1 }),
      }),
    });
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select all passes on this page' }),
    );
    expect(await screen.findByText(/Narrow to 200 to select all/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /matching$/ })).toBeNull();
  });
});
