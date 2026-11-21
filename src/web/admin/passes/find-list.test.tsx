import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PASS_SELECTION_MAX } from '@/shared/contracts/pass-selection.ts';
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
    '/api/v1/passes/bulk-runs/current': () => json({}),
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

  it('asks to narrow when more match than one run covers', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': () =>
          json({ items: [passSummary()], nextCursor: 'c', count: PASS_SELECTION_MAX + 1 }),
      }),
    });
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select all passes on this page' }),
    );
    expect(await screen.findByText(/Narrow to 20,000 to select all/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /matching$/ })).toBeNull();
  });

  it('runs a big selection in the background and shows its progress with Stop', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let stopped = false;
    const run = (state: string, done: number) => ({
      id: 'run1',
      orgId: ORG.id,
      action: 'void',
      state,
      total: 150,
      done,
      skipped: 0,
      skippedBy: {},
      stopRequested: stopped,
      createdAt: 1,
      finishedAt: null,
      code: null,
    });
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: 'c', count: 150 }),
        '/api/v1/passes/bulk-runs': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(run('queued', 0), 202);
        },
        '/api/v1/passes/bulk-runs/run1': () => json(run('running', 40)),
        '/api/v1/passes/bulk-runs/run1/stop': () => {
          stopped = true;
          return json(run('running', 40));
        },
      }),
    });
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select all passes on this page' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Select all 150 matching' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await user.click(within(bar).getByRole('button', { name: 'Void' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Void 150 passes?' });
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        { action: 'void', orgId: ORG.id, selection: { filter: {}, expectCount: 150 } },
      ]),
    );
    expect(await screen.findByText('Voiding 40 of 150')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('button', { name: 'Stopping' })).toBeDisabled();
  });

  it('shows the run that is going when the page loads', async () => {
    const run = {
      id: 'run9',
      orgId: ORG.id,
      action: 'void',
      state: 'running',
      total: 150,
      done: 40,
      skipped: 0,
      skippedBy: {},
      stopRequested: false,
      createdAt: 1,
      finishedAt: null,
      code: null,
    };
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null, count: 1 }),
        '/api/v1/passes/bulk-runs/current': () => json({ run }),
        '/api/v1/passes/bulk-runs/run9': () => json(run),
      }),
    });
    expect(await screen.findByText('Voiding 40 of 150')).toBeInTheDocument();
  });
});
