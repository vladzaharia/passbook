import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { PassSummarySchema } from '@/shared/contracts/passes.ts';
import { resetModeForTests, setMode } from '../../lib/mode.ts';
import { createQueryClient } from '../../lib/query-client.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '../../lib/test-utils.tsx';
import { TooltipProvider, toast } from '../../ui/index.ts';
import { SelectionBar } from './selection-bar.tsx';
import {
  ORG,
  passSummary,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const orgScope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};

afterEach(resetModeForTests);
afterEach(() => vi.restoreAllMocks());

const empty = () => json({ items: [], nextCursor: null });
const bundle = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  orgId: 'org1',
  mode: 'live',
  name: 'Trip',
  url: 'https://wallet.test/b/tok',
  holderEmail: null,
  passes: [{ id: 'p1', title: 'Pass 1', status: 'active' }],
  createdAt: 1,
  linkRotatedAt: null,
  ...over,
});

function handlers(extra: Record<string, FetchHandler> = {}): Record<string, FetchHandler> {
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

const passes = (url: URL, orgs: string[] = ['org1', 'org1'], mode: 'live' | 'test' = 'live') =>
  json({
    items: orgs.flatMap((orgId, i) =>
      orgId === url.searchParams.get('orgId')
        ? [
            passSummary({
              id: `p${i + 1}`,
              orgId,
              mode,
              title: `Pass ${i + 1}`,
              serial: `S-${i}`,
            }),
          ]
        : [],
    ),
    nextCursor: null,
  });

describe('Share as bundle', () => {
  it('names the bundle, creates it and shows the link', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { container } = await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': (url) => passes(url),
        '/api/v1/bundles': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(bundle(), 201);
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Pass 2' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await user.click(within(bar).getByRole('button', { name: 'Share as bundle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    expect((await axe(container)).violations).toEqual([]);
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ orgId: 'org1', passIds: ['p1', 'p2'], name: 'Trip' }]),
    );
    const done = await screen.findByRole('dialog', { name: 'Trip' });
    expect(within(done).getByText('https://wallet.test/b/tok')).toBeInTheDocument();
    expect(within(done).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)(
    'does not publish a bundle result to a different principal on %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      const user = userEvent.setup();
      const { queryClient, fetchMock } = await renderApp('/admin/passes', {
        session: 'admin',
        ...orgScope,
        handlers: handlers({
          '/api/v1/passes': (url) => passes(url),
          '/api/v1/bundles': () => response.promise,
        }),
      });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
      await user.click(
        within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
          name: 'Share as bundle',
        }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
      await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Private bundle');
      await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/bundles',
          ),
        ).toBe(true),
      );

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' }),
          ],
        });
      });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Share as bundle' })).toBeNull(),
      );
      await act(async () => {
        response.resolve(
          outcome === 'success'
            ? json(bundle({ name: 'Private bundle' }), 201)
            : problem(500, 'failure', 'Bundle request failed.'),
        );
        await response.promise;
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(screen.queryByRole('dialog', { name: 'Private bundle' })).toBeNull();
      expect(screen.queryByText('Bundle request failed.')).toBeNull();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'does not publish a bulk email result to a different principal on %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      const user = userEvent.setup();
      const { queryClient, fetchMock } = await renderApp('/admin/passes', {
        session: 'admin',
        ...orgScope,
        handlers: handlers({
          '/api/v1/passes': (url) => passes(url),
          '/api/v1/passes/bulk': () => response.promise,
        }),
      });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const info = vi.spyOn(toast, 'info');
      const error = vi.spyOn(toast, 'error');
      await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
      await user.click(
        within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
          name: 'Send email',
        }),
      );
      const dialog = await screen.findByRole('alertdialog', { name: 'Email 1 holder?' });
      await user.click(within(dialog).getByRole('button', { name: 'Send email' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input]) =>
              new URL(String(input), 'http://localhost').pathname === '/api/v1/passes/bulk',
          ),
        ).toBe(true),
      );

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' }),
          ],
        });
      });
      await waitFor(() =>
        expect(screen.queryByRole('alertdialog', { name: 'Email 1 holder?' })).toBeNull(),
      );
      await act(async () => {
        response.resolve(
          outcome === 'success'
            ? json({ done: 1, skipped: [] })
            : problem(500, 'failure', 'Bulk email failed.'),
        );
        await response.promise;
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(screen.queryByText('Bulk email failed.')).toBeNull();
    },
  );

  it('requests email without claiming it was queued or delivered', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': (url) => passes(url),
        '/api/v1/bundles': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(bundle({ holderEmail: 'mia@example.com' }), 201);
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Share as bundle',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.type(within(dialog).getByRole('textbox', { name: /Email/ }), 'mia@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create and email' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        {
          orgId: 'org1',
          passIds: ['p1'],
          name: 'Trip',
          holderEmail: 'mia@example.com',
          sendEmail: true,
        },
      ]),
    );
    expect(await screen.findByText('Email requested for mia@example.com.')).toBeInTheDocument();
    expect(screen.queryByText('Link emailed to mia@example.com.')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Trip' }).querySelector('.wl-add-buddy')).toBeNull();
  });

  it('links to the Test inbox without claiming an email was captured', async () => {
    setMode('test');
    const user = userEvent.setup();
    await renderApp('/admin/passes', {
      session: 'admin',
      ...orgScope,
      handlers: handlers({
        '/api/v1/passes': (url) => passes(url, ['org1', 'org1'], 'test'),
        '/api/v1/bundles': () =>
          json(bundle({ mode: 'test', holderEmail: 'mia@example.com' }), 201),
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Share as bundle',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.type(within(dialog).getByRole('textbox', { name: /Email/ }), 'mia@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create and email' }));
    const result = await screen.findByRole('dialog', { name: 'Trip' });
    expect(within(result).getByText('Email requested for mia@example.com.')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'Open Test inbox' })).toHaveAttribute(
      'href',
      '/admin/test-inbox?orgId=org1',
    );
    expect(within(result).queryByText('Link captured in the Test inbox.')).not.toBeInTheDocument();
  });

  it('clears the selection when switching organizations and shares only the new scope', async () => {
    const user = userEvent.setup();
    const seen: (string | null)[] = [];
    const previewOrgs: (string | null)[] = [];
    const bodies: unknown[] = [];
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const org2Ready = deferred.withResolvers<void>();
    await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [
        ...orgScope.memberships,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers({
        '/api/v1/passes': async (url) => {
          seen.push(url.searchParams.get('orgId'));
          if (url.searchParams.get('orgId') === 'org2') await org2Ready.promise;
          return passes(url, ['org1', 'org2']);
        },
        '/api/v1/templates/previews': (url) => {
          previewOrgs.push(url.searchParams.get('orgId'));
          return previewsHandler(url);
        },
        '/api/v1/bundles': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(
            bundle({ orgId: 'org2', passes: [{ id: 'p2', title: 'Pass 2', status: 'active' }] }),
            201,
          );
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Select Pass 1' }));
    await waitFor(() => expect(previewOrgs).toContain('org1'));
    expect(screen.queryByRole('checkbox', { name: 'Select Pass 2' })).toBeNull();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    await waitFor(() => expect(seen).toContain('org2'));
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Select Pass 1' })).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
    org2Ready.resolve(undefined);
    const second = await screen.findByRole('checkbox', { name: 'Select Pass 2' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
    expect(screen.queryByRole('checkbox', { name: 'Select Pass 1' })).toBeNull();
    expect(seen).toContain('org1');
    expect(seen).toContain('org2');
    expect(seen.every((orgId) => orgId === 'org1' || orgId === 'org2')).toBe(true);
    await waitFor(() => expect(previewOrgs).toContain('org2'));
    expect(previewOrgs.every((orgId) => orgId === 'org1' || orgId === 'org2')).toBe(true);
    await user.click(second);
    await user.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Share as bundle',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share as bundle' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Trip');
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: 'org2', passIds: ['p2'], name: 'Trip' }]));
  });

  it('disables sharing when the selection spans organizations', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>
          <SelectionBar
            picked={[
              PassSummarySchema.parse(passSummary()),
              PassSummarySchema.parse(passSummary({ id: 'p2', orgId: 'org2' })),
            ]}
            orgId={undefined}
            canOperate
            bundleOrgId={null}
            onClear={() => {}}
            onExport={() => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const share = within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
      name: 'Share as bundle',
    });
    expect(share).toBeDisabled();
    expect(share).toHaveAccessibleDescription('Up to 10 passes of one organization.');
    expect(screen.queryByRole('dialog', { name: 'Share as bundle' })).toBeNull();
  });
});
