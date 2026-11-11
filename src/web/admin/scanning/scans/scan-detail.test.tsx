import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { templateDetail, templateReleaseList } from '../../passes/test-fixtures.ts';
import { NOW } from '../test-fixtures.ts';

const record = {
  id: 'scan-1',
  at: NOW,
  outcome: 'refused',
  reason: 'wrong_event',
  kind: 'check_in',
  actionId: null,
  actionLabel: 'Check in',
  direction: null,
  passId: 'pass-1',
  passTitle: 'Anna',
  templateId: 't1',
  templateName: 'Ticket',
  eventId: null,
  eventName: null,
  scannerId: 's1',
  scannerName: 'Front door',
  staffId: null,
  staffName: null,
  approvedBy: null,
  method: 'manual',
  amount: null,
  before: null,
  after: null,
  passVersion: 7,
  override: false,
  offline: false,
  actor: { type: 'scanner', id: 's1' },
  undoneAt: null,
  undoneBy: null,
  undoes: null,
};
const page = (items: unknown[]) => json({ items, nextCursor: null });
const member = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const other = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });

afterEach(() => resetModeForTests());

function open(
  over: {
    memberships?: OrgMembership[];
    template?: () => Response | Promise<Response>;
    release?: (url: URL) => Response | Promise<Response>;
    scan?: Record<string, unknown>;
  } = {},
) {
  const templates: URL[] = [];
  const releases: URL[] = [];
  const render = renderApp('/admin/scanning?tab=scans', {
    session: 'admin',
    memberships: over.memberships ?? [member],
    selectedOrg: 'o1',
    handlers: {
      '/api/v1/scan-setups': () => page([]),
      '/api/v1/scanning-sessions': () => page([]),
      '/api/v1/scan-events': () => page([]),
      '/api/v1/scans': (url) =>
        page(url.searchParams.get('orgId') === 'o1' ? [{ ...record, ...over.scan }] : []),
      '/api/v1/templates/t1': (url) => {
        templates.push(url);
        return over.template?.() ?? json(templateDetail({ id: 't1', orgId: 'o1' }));
      },
      '/api/v1/templates/t1/releases': (url) => {
        releases.push(url);
        return (
          over.release?.(url) ??
          json(
            templateReleaseList({
              templateId: 't1',
              orgId: 'o1',
              mode: 'live',
              version: 'approved-v2',
            }),
          )
        );
      },
    },
  });
  return { render, templates, releases };
}

async function openScan(name = 'Anna') {
  const row = (await screen.findByText(name)).closest('tr');
  expect(row).not.toBeNull();
  await userEvent.setup().click(within(row as HTMLElement).getByRole('button'));
  return screen.findByRole('dialog', { name: 'Scan' });
}

describe('Scan history release context', () => {
  it('keeps the recorded pass version and reason separate from the current approved release', async () => {
    const state = open({
      template: () => json(templateDetail({ id: 't1', orgId: 'o1', activeVersion: 'draft-v99' })),
    });
    await state.render;
    const sheet = await openScan();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    expect(await within(sheet).findByText('Active · approved-v2')).toBeInTheDocument();
    expect(within(sheet).getByText('Current Apple Wallet release')).toBeInTheDocument();
    expect(within(sheet).getByText(/separate from the pass version recorded/)).toBeInTheDocument();
    await userEvent.setup().click(within(sheet).getByText('Technical details'));
    expect(within(sheet).getByText('Reason').nextElementSibling).toHaveTextContent('wrong_event');
    expect(within(sheet).queryByText(/stale|outdated/i)).not.toBeInTheDocument();
    expect(state.templates.map((url) => url.searchParams.get('orgId'))).toEqual(['o1']);
    expect(state.releases).toHaveLength(1);
    expect(Object.fromEntries(state.releases[0]!.searchParams)).toMatchObject({
      orgId: 'o1',
      mode: 'live',
      provider: 'apple',
    });
  });

  it('revalidates cached template and release metadata before showing current status', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const template = deferred.withResolvers<Response>();
    const release = deferred.withResolvers<Response>();
    const state = open({ template: () => template.promise, release: () => release.promise });
    const { queryClient } = await state.render;
    queryClient.setQueryData(
      ['admin', 'templates', 'scan-release-template', 'o1', 't1', 'live'],
      templateDetail({ id: 't1', orgId: 'o1' }),
    );
    queryClient.setQueryData(
      ['admin', 'templates', 'current-template-release', 'o1', 't1', 'live', 'apple'],
      templateReleaseList({ templateId: 't1', orgId: 'o1', version: 'cached-release' }),
    );
    const sheet = await openScan();
    await waitFor(() => expect(state.templates).toHaveLength(1));
    expect(within(sheet).queryByText(/cached-release/)).not.toBeInTheDocument();
    expect(state.releases).toEqual([]);
    await act(async () => {
      template.resolve(json(templateDetail({ id: 't1', orgId: 'o1' })));
    });
    await waitFor(() => expect(state.releases).toHaveLength(1));
    expect(within(sheet).queryByText(/cached-release/)).not.toBeInTheDocument();
    await act(async () => {
      release.resolve(
        json(templateReleaseList({ templateId: 't1', orgId: 'o1', version: 'fresh-release' })),
      );
    });
    expect(await within(sheet).findByText('Active · fresh-release')).toBeInTheDocument();
  });

  it('shows no active release without changing the historical reason', async () => {
    const state = open({ release: () => json({ active: null, items: [] }) });
    await state.render;
    const sheet = await openScan();
    expect(await within(sheet).findByText('No active approved release')).toBeInTheDocument();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    await userEvent.setup().click(within(sheet).getByText('Technical details'));
    expect(within(sheet).getByText('Reason').nextElementSibling).toHaveTextContent('wrong_event');
  });

  it('does not request template metadata without templates:read', async () => {
    const state = open({
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] })],
    });
    await state.render;
    const sheet = await openScan();
    expect(within(sheet).getByText('Unavailable — template access required')).toBeInTheDocument();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    expect(state.templates).toEqual([]);
    expect(state.releases).toEqual([]);
  });

  it('does not request current release data when template details are unavailable', async () => {
    const state = open({ scan: { templateId: null, templateName: null } });
    await state.render;
    const sheet = await openScan();
    expect(
      within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
    ).toHaveTextContent('Unavailable');
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    expect(state.templates).toEqual([]);
    expect(state.releases).toEqual([]);
  });

  it('uses neutral labels for a minimally redacted successful scan', async () => {
    const state = open({
      scan: {
        outcome: 'ok',
        reason: null,
        kind: null,
        actionId: null,
        actionLabel: null,
        passId: null,
        passTitle: null,
        templateId: null,
        templateName: null,
        passVersion: null,
      },
    });
    await state.render;
    const sheet = await openScan('Pass details unavailable');
    expect(
      within(sheet).getByRole('heading', { name: 'Pass details unavailable' }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText('Pass', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('Unavailable');
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '—',
    );
    expect(
      within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
    ).toHaveTextContent('Unavailable');
    expect(screen.queryByText('Unknown code')).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/pass version recorded/i)).not.toBeInTheDocument();
    expect(
      within(sheet).queryByText(/unknown code|stale|outdated|template not recorded/i),
    ).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: /pass/i })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Undo check-in' })).not.toBeInTheDocument();
    expect(state.templates).toEqual([]);
    expect(state.releases).toEqual([]);
  });

  it('preserves history and does not fetch releases when the template request is forbidden', async () => {
    const state = open({ template: () => problem(403, 'forbidden', 'Forbidden.') });
    await state.render;
    const sheet = await openScan();
    expect(await within(sheet).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    expect(state.releases).toEqual([]);
  });

  it('preserves the recorded result if release metadata is forbidden', async () => {
    const state = open({ release: () => problem(403, 'forbidden', 'Forbidden.') });
    await state.render;
    const sheet = await openScan();
    expect(await within(sheet).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
    await userEvent.setup().click(within(sheet).getByText('Technical details'));
    expect(within(sheet).getByText('Reason').nextElementSibling).toHaveTextContent('wrong_event');
  });

  it('does not expose or request a release for a template owned by another organization', async () => {
    const state = open({
      memberships: [member, other],
      template: () => json(templateDetail({ id: 't1', orgId: 'o2', name: 'Private template' })),
    });
    await state.render;
    const sheet = await openScan();
    await waitFor(() =>
      expect(
        within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
      ).toHaveTextContent('Unavailable'),
    );
    expect(within(sheet).queryByText('Private template')).not.toBeInTheDocument();
    expect(state.releases).toEqual([]);
  });

  it('masks a release returned for a different organization', async () => {
    const state = open({
      release: () =>
        json(templateReleaseList({ templateId: 't1', orgId: 'o2', version: 'foreign-secret' })),
    });
    await state.render;
    const sheet = await openScan();
    await waitFor(() =>
      expect(
        within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
      ).toHaveTextContent('Unavailable'),
    );
    expect(within(sheet).queryByText(/foreign-secret/)).not.toBeInTheDocument();
    expect(within(sheet).getByText('Pass version at scan').nextElementSibling).toHaveTextContent(
      '7',
    );
  });

  it.each([{ mode: 'test' }, { templateId: 'other-template' }])(
    'does not display a release with mismatched identity: %o',
    async (mismatch) => {
      const state = open({
        release: () =>
          json(
            templateReleaseList({
              templateId: 't1',
              orgId: 'o1',
              mode: 'live',
              version: 'wrong-release',
              ...mismatch,
            }),
          ),
      });
      await state.render;
      const sheet = await openScan();
      await waitFor(() =>
        expect(
          within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
        ).toHaveTextContent('Unavailable'),
      );
      expect(within(sheet).queryByText(/wrong-release/)).not.toBeInTheDocument();
    },
  );

  it('shows a trusted baked system release in an authorized organization', async () => {
    const state = open({
      template: () =>
        json(templateDetail({ id: 't1', orgId: null, orgName: null, origin: 'baked' })),
      release: () =>
        json(
          templateReleaseList({
            templateId: 't1',
            orgId: null,
            mode: 'live',
            source: 'system',
            action: 'system',
            candidateId: null,
            approvalId: null,
            version: 'system-v1',
          }),
        ),
    });
    await state.render;
    const sheet = await openScan();
    expect(await within(sheet).findByText('Active · system-v1')).toBeInTheDocument();
  });

  it('shows an organization-approved release for a shared uploaded template', async () => {
    const state = open({
      template: () =>
        json(templateDetail({ id: 't1', orgId: null, orgName: null, origin: 'uploaded' })),
      release: () =>
        json(templateReleaseList({ templateId: 't1', orgId: 'o1', version: 'scoped-v1' })),
    });
    await state.render;
    const sheet = await openScan();
    expect(await within(sheet).findByText('Active · scoped-v1')).toBeInTheDocument();
  });

  it('does not trust a system-wide release on an uploaded template', async () => {
    const state = open({
      template: () =>
        json(templateDetail({ id: 't1', orgId: null, orgName: null, origin: 'uploaded' })),
      release: () =>
        json(
          templateReleaseList({
            templateId: 't1',
            orgId: null,
            source: 'system',
            action: 'system',
            candidateId: null,
            approvalId: null,
            version: 'untrusted-system',
          }),
        ),
    });
    await state.render;
    const sheet = await openScan();
    await waitFor(() =>
      expect(
        within(sheet).getByText('Current Apple Wallet release').nextElementSibling,
      ).toHaveTextContent('Unavailable'),
    );
    expect(within(sheet).queryByText(/untrusted-system/)).not.toBeInTheDocument();
  });

  it('does not expose a late release after switching organizations', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const pending = deferred.withResolvers<Response>();
    const state = open({ memberships: [member, other], release: () => pending.promise });
    const { router } = await state.render;
    await openScan();
    await waitFor(() => expect(state.releases).toHaveLength(1));
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2', tab: 'scans' } });
    });
    expect(await screen.findByText('No scans yet')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scan' })).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(
        json(templateReleaseList({ templateId: 't1', orgId: 'o1', version: 'old-release' })),
      );
    });
    expect(screen.queryByText(/old-release/)).not.toBeInTheDocument();
  });

  it('closes the historical scan when the console mode changes', async () => {
    const state = open();
    await state.render;
    await openScan();
    act(() => setMode('test'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Scan' })).not.toBeInTheDocument(),
    );
  });
});
