import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgExport } from '@/shared/operations/kinds/org-export.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { fixtureOperation } from '@/web/ui/operation/fixtures.test-support.ts';

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};
const def = {
  kind: orgExport.kind,
  title: orgExport.title,
  doneTitle: orgExport.doneTitle,
  failTitle: orgExport.failTitle,
  steps: orgExport.steps.map((s) => ({ key: s.key, label: s.label, active: s.active })),
};
const operation = (o: Parameters<typeof fixtureOperation>[1]) => ({
  ...fixtureOperation(def, { id: 'op-1', ...o }),
  target: { type: 'export', id: 'e1' },
  result: o.status === 'succeeded' ? { href: null, ids: { exportId: 'e1' } } : null,
});
const row = (id: string, state: string) => ({
  id,
  state,
  createdAt: 1_700_000_000_000,
  finishedAt: state === 'ready' ? 1_700_000_100_000 : null,
  expiresAt: state === 'ready' ? Date.now() + 86_400_000 : null,
  bytes: state === 'ready' ? 2_621_440 : null,
  entities: null,
  errorCode: null,
});

function setup(handlers: Record<string, (u: URL, init?: RequestInit) => Response>) {
  return renderApp('/admin/o/o1/settings', {
    session: 'admin',
    memberships: [membershipFixture('o1')],
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      '/api/v1/orgs/o1/workspace': () => json(org),
      '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
      '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
      '/api/v1/settings': () => json({ items: [] }),
      '/api/v1/operations': () => json({ items: [], nextCursor: null }),
      ...handlers,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings > Data', () => {
  it('starts an export and shows its steps with a count, then offers the download', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await setup({
      '/api/v1/orgs/o1/exports': (_u, init) =>
        init?.method === 'POST'
          ? json({ ...row('e1', 'queued'), operationId: 'op-1' }, 202)
          : json({ items: [], nextCursor: null }),
      '/api/v1/operations/op-1': () =>
        json(
          polls++ === 0
            ? operation({ status: 'running', at: 'rows', counts: { done: 3, total: 9 } })
            : operation({ status: 'succeeded' }),
        ),
      '/api/v1/orgs/o1/exports/e1/link': () =>
        json({ url: 'https://wallet.test/api/v1/org-exports/e1/download?x=1', expiresAt: 1 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Export data' }));
    expect(await screen.findByText('Writing records · 3 of 9')).toBeInTheDocument();
    const download = await screen.findByRole('button', { name: 'Download' }, { timeout: 5000 });
    await user.click(download);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('/download')));
  });

  it('resumes a running export after a reload, and offers the last ready one', async () => {
    await setup({
      '/api/v1/orgs/o1/exports': () =>
        json({ items: [row('e0', 'ready'), row('e1', 'running')], nextCursor: null }),
      '/api/v1/operations': (u) =>
        json({
          items:
            u.searchParams.get('kind') === 'org.export'
              ? [operation({ status: 'running', at: 'zip' })]
              : [],
          nextCursor: null,
        }),
      '/api/v1/operations/op-1': () => json(operation({ status: 'running', at: 'zip' })),
    });
    expect(await screen.findByText('Building the archive')).toBeInTheDocument();
  });

  it('shows Retry on a failed export', async () => {
    await setup({
      '/api/v1/orgs/o1/exports': () => json({ items: [], nextCursor: null }),
      '/api/v1/operations': (u) =>
        json({
          items:
            u.searchParams.get('kind') === 'org.export'
              ? [
                  {
                    ...operation({ status: 'failed', at: 'zip' }),
                    error: {
                      code: 'ORG_EXPORT_FAILED',
                      message: 'The export did not finish. Retry.',
                      step: 'zip',
                      retryable: true,
                    },
                  },
                ]
              : [],
          nextCursor: null,
        }),
      '/api/v1/operations/op-1': () =>
        json({
          ...operation({ status: 'failed', at: 'zip' }),
          error: {
            code: 'ORG_EXPORT_FAILED',
            message: 'The export did not finish. Retry.',
            step: 'zip',
            retryable: true,
          },
        }),
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
