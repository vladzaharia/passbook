import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { json, problem, stubFetch } from '../../../lib/test-utils.tsx';
import { TemplateReleasesPanel } from './template-releases-panel.tsx';
import {
  approval,
  CANDIDATE_HASH,
  CONTENT_HASH,
  candidate,
  mountPanel,
  panelProps,
  release,
  releaseServer,
  TEMPLATE,
  VERSIONS,
} from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

describe('template release panel', () => {
  it('scopes both GETs and their cache by template, organization, and explicit mode', async () => {
    // The panel's explicit live mode must override the opposite global mode header.
    setMode('test');
    const seen: { path: string; method: string; query: string[][]; header: string | null }[] = [];
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const delayedOrg2 = deferred.withResolvers<Response>();
    const handler = (url: URL, init?: RequestInit) => {
      const orgId = url.searchParams.get('orgId') ?? '';
      const mode = url.searchParams.get('mode') === 'test' ? 'test' : 'live';
      const templateId = url.pathname.split('/')[4] ?? '';
      seen.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        query: Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b)),
        header: new Headers(init?.headers).get('x-passbook-mode'),
      });
      const fingerprint =
        templateId === 'template-2' ? '4' : orgId === 'org-2' ? '3' : mode === 'test' ? '2' : '1';
      if (
        templateId === 'template-1' &&
        orgId === 'org-2' &&
        url.pathname.endsWith('/candidates')
      ) {
        return delayedOrg2.promise;
      }
      return url.pathname.endsWith('/candidates')
        ? json({
            items: [candidate({ templateId, orgId, mode, candidateHash: fingerprint.repeat(64) })],
          })
        : json({ active: null, items: [] });
    };
    stubFetch({
      '/api/v1/templates/template-1/candidates': handler,
      '/api/v1/templates/template-1/releases': handler,
      '/api/v1/templates/template-2/candidates': handler,
      '/api/v1/templates/template-2/releases': handler,
    });
    const view = mountPanel({ templateOrgId: null });
    expect(await screen.findByText('1'.repeat(64))).toBeInTheDocument();
    view.rerender(<TemplateReleasesPanel {...panelProps({ templateOrgId: null, mode: 'test' })} />);
    expect(await screen.findByText('2'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText('1'.repeat(64))).not.toBeInTheDocument();
    view.rerender(
      <TemplateReleasesPanel
        {...panelProps({ templateOrgId: null, mode: 'test', orgId: 'org-2' })}
      />,
    );
    expect(screen.queryByText('2'.repeat(64))).not.toBeInTheDocument();
    expect(await screen.findByText(/Loading releases and candidates/)).toBeInTheDocument();
    delayedOrg2.resolve(
      json({ items: [candidate({ orgId: 'org-2', mode: 'test', candidateHash: '3'.repeat(64) })] }),
    );
    expect(await screen.findByText('3'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText('2'.repeat(64))).not.toBeInTheDocument();
    view.rerender(
      <TemplateReleasesPanel
        {...panelProps({
          templateId: 'template-2',
          templateOrgId: null,
          mode: 'test',
          orgId: 'org-2',
        })}
      />,
    );
    expect(await screen.findByText('4'.repeat(64))).toBeInTheDocument();
    view.rerender(<TemplateReleasesPanel {...panelProps({ templateOrgId: null })} />);
    expect(await screen.findByText('1'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText('4'.repeat(64))).not.toBeInTheDocument();

    const scopes = [
      ['template-1', 'org-1', 'live'],
      ['template-1', 'org-1', 'test'],
      ['template-1', 'org-2', 'test'],
      ['template-2', 'org-2', 'test'],
    ] as const;
    for (const [template, org, mode] of scopes) {
      for (const resource of ['candidates', 'releases']) {
        expect(seen).toContainEqual({
          path: `/api/v1/templates/${template}/${resource}`,
          method: 'GET',
          query: [
            ['mode', mode],
            ['orgId', org],
            ['provider', 'apple'],
          ],
          header: mode,
        });
      }
    }
    expect(seen).toHaveLength(8);
  });

  it('asks for an organization without making unscoped requests and explains provider availability', () => {
    const fetch = stubFetch({});
    mountPanel({ orgId: undefined });
    expect(screen.getByText(/Select an organization to view and manage/)).toBeInTheDocument();
    expect(screen.queryByText(/offers unavailable|release workflow/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fetch or offer actions for a different owning organization', () => {
    const fetch = stubFetch({});
    mountPanel({ orgId: 'org-2' });
    expect(screen.getByText(/Select the template’s owning organization/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create candidate' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows an empty active release and candidate snapshot without allowing publication before review', async () => {
    releaseServer({ candidates: [candidate()] });
    mountPanel();
    expect(await screen.findByText(/No active release for this organization/)).toBeInTheDocument();
    expect(screen.getByText(/No releases yet/)).toBeInTheDocument();
    const candidates = screen.getByRole('list', { name: 'Release candidates' });
    expect(within(candidates).getByText('Ada Author')).toBeVisible();
    expect(within(candidates).getByText('Vera Versioner')).toBeVisible();
    // Ids and hashes are present but closed behind the disclosure.
    const details = within(candidates).getByText('Technical details').closest('details');
    expect(details).not.toHaveAttribute('open');
    for (const value of [CANDIDATE_HASH, CONTENT_HASH, 'barcode, nfc'])
      expect(within(candidates).getByText(value)).not.toBeVisible();
    expect(within(candidates).getByText('4')).toBeInTheDocument();
    expect(within(candidates).getByText('3')).toBeInTheDocument();
    expect(within(candidates).getByText(/Approval required before publishing/)).toBeInTheDocument();
    expect(
      within(candidates).getByRole('button', { name: 'Publish candidate for Version 2' }),
    ).toBeDisabled();
  });

  it.each([
    { candidates: [], history: [], next: /Create a candidate from a saved version/i },
    {
      candidates: [candidate()],
      history: [],
      next: /different reviewer must approve/i,
    },
    {
      candidates: [candidate({ approvals: [approval()] })],
      history: [],
      next: /publisher can release an approved/i,
    },
    {
      candidates: [candidate({ approvals: [approval({ candidateHash: 'd'.repeat(64) })] })],
      history: [],
      next: /different reviewer must approve/i,
    },
    {
      candidates: [candidate({ approvals: [approval()] })],
      history: [
        release({
          candidateId: 'candidate-1',
          approvalId: 'approval-1',
          candidateHash: CANDIDATE_HASH,
          version: 'version-2',
        }),
      ],
      next: /Create a candidate from a saved version/i,
    },
  ])(
    'explains the next step when issuance has no active release',
    async ({ candidates, history, next }) => {
      releaseServer({ candidates, history });
      mountPanel();
      const blocked = await screen.findByText(/No active release for this organization/);
      expect(blocked).toHaveTextContent(/Issuing passes is blocked/i);
      expect(blocked).toHaveTextContent(next);
    },
  );

  it.each([
    ['candidate hash', { candidateHash: 'd'.repeat(64) }],
    ['candidate ID', { candidateId: 'another-candidate' }],
    ['candidate author', { reviewerId: 'candidate-author' }],
    ['version author', { reviewerId: 'version-author' }],
  ] as const)(
    'does not publish with an approval that mismatches the %s',
    async (_label, overrides) => {
      releaseServer({ candidates: [candidate({ approvals: [approval(overrides)] })] });
      mountPanel();
      expect(
        await screen.findByRole('button', { name: 'Publish candidate for Version 2' }),
      ).toBeDisabled();
    },
  );

  it.each([
    ['candidate author', 'candidate-author'],
    ['version author', 'version-author'],
  ] as const)('prevents self-review by the %s', async (_label, currentUserId) => {
    const server = releaseServer({ candidates: [candidate()] });
    mountPanel({ currentUserId });
    expect(
      await screen.findByText(/You cannot review a candidate or version you authored/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve candidate for Version 2' })).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('blocks approval when the reviewer identity is unavailable', async () => {
    releaseServer({ candidates: [candidate()] });
    mountPanel({ currentUserId: null });
    expect(await screen.findByText(/Your identity is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve candidate for Version 2' })).toBeDisabled();
  });

  it.each([
    { description: 'already independently approved', approvals: [approval()], history: [] },
    {
      description: 'already released',
      approvals: [approval()],
      history: [
        release({
          candidateId: 'candidate-1',
          approvalId: 'approval-1',
          candidateHash: CANDIDATE_HASH,
          version: 'version-2',
        }),
      ],
    },
  ])('does not approve a candidate that is $description', async ({ approvals, history }) => {
    const server = releaseServer({ candidates: [candidate({ approvals })], history });
    mountPanel();
    expect(
      await screen.findByRole('button', { name: 'Approve candidate for Version 2' }),
    ).toBeDisabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it.each([
    {
      name: 'read only',
      capabilities: ['templates:read'],
      author: false,
      review: false,
      publish: false,
    },
    {
      name: 'author',
      capabilities: ['templates:read', 'templates:author'],
      author: true,
      review: false,
      publish: false,
    },
    {
      name: 'reviewer',
      capabilities: ['templates:read', 'templates:review'],
      author: false,
      review: true,
      publish: false,
    },
    {
      name: 'publisher',
      capabilities: ['templates:read', 'templates:publish'],
      author: false,
      review: false,
      publish: true,
    },
  ] as const)(
    'exposes only the permitted controls for a $name',
    async ({ capabilities, author, review, publish }) => {
      const user = userEvent.setup();
      const previous = release({ id: 'previous', generation: 1 });
      const head = release({ id: 'head', generation: 2 });
      releaseServer({
        candidates: [
          candidate({ approvals: [approval()] }),
          candidate({
            id: 'candidate-pending',
            version: 'version-1',
            candidateHash: 'f'.repeat(64),
          }),
        ],
        active: head,
        history: [head, previous],
      });
      mountPanel({ capabilities });
      await screen.findByRole('heading', { name: 'Version 2' });
      const create = screen.queryByRole('button', { name: 'Create candidate' });
      const approveButton = screen.queryByRole('button', {
        name: 'Approve candidate for Version 1',
      });
      const publishButton = screen.queryByRole('button', {
        name: 'Publish candidate for Version 2',
      });
      const rollback = screen.queryByRole('button', {
        name: 'Roll back to Version 1 (generation 1)',
      });
      if (author) {
        expect(create).toBeInTheDocument();
        await user.click(screen.getByRole('combobox', { name: 'Saved version' }));
        await user.click(screen.getByRole('option', { name: /Version 2/ }));
        expect(create).toBeEnabled();
      } else expect(create).not.toBeInTheDocument();
      if (review) expect(approveButton).toBeEnabled();
      else expect(approveButton).not.toBeInTheDocument();
      if (publish) {
        expect(publishButton).toBeEnabled();
        expect(rollback).toBeEnabled();
      } else {
        expect(publishButton).not.toBeInTheDocument();
        expect(rollback).not.toBeInTheDocument();
      }
    },
  );

  it.each([
    { name: 'the owner in test mode', mode: 'test', templateOrgId: 'org-1', restore: false },
    { name: 'a shared template in live mode', mode: 'live', templateOrgId: null, restore: false },
    { name: 'a shared template in test mode', mode: 'test', templateOrgId: null, restore: false },
    { name: 'the owner in live mode', mode: 'live', templateOrgId: 'org-1', restore: true },
  ] as const)(
    'only permits restoring an archived template for $name',
    async ({ mode, templateOrgId, restore }) => {
      const previous = release({ id: 'previous', generation: 1, mode });
      const head = release({ id: 'head', generation: 2, mode });
      releaseServer({
        candidates: [candidate({ mode, approvals: [approval()] })],
        history: [head, previous],
      });
      mountPanel({ templateStatus: 'archived', templateOrgId, mode });
      await screen.findByRole('heading', { name: 'Version 2' });
      expect(screen.getByRole('status')).toHaveTextContent(/No active release/);
      expect(screen.queryByText(/Roll back to an approved release in live mode/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create candidate' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Approve candidate for Version 2' }),
      ).not.toBeInTheDocument();
      const publish = screen.queryByRole('button', { name: 'Publish candidate for Version 2' });
      const rollback = screen.queryByRole('button', {
        name: 'Roll back to Version 1 (generation 1)',
      });
      if (restore) {
        expect(publish).toBeEnabled();
        expect(rollback).toBeEnabled();
      } else {
        expect(publish).not.toBeInTheDocument();
        expect(rollback).not.toBeInTheDocument();
      }
    },
  );

  it('treats built-in releases as system managed', async () => {
    const system = release({
      source: 'system',
      action: 'system',
      orgId: null,
      candidateId: null,
      approvalId: null,
    });
    releaseServer({ active: system, history: [system] });
    mountPanel({ templateOrigin: 'baked', templateOrgId: null });
    expect(
      await screen.findByText(/Built-in releases are managed by the system/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create candidate' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /Approve candidate|Publish candidate|Roll back to/,
      }),
    ).not.toBeInTheDocument();
  });

  it('never offers rollback to the head or a system release', async () => {
    const head = release({ id: 'head', generation: 3 });
    const system = release({
      id: 'system',
      generation: 1,
      source: 'system',
      action: 'system',
      candidateId: null,
      approvalId: null,
    });
    releaseServer({ active: head, history: [head, system] });
    mountPanel();
    await screen.findByText(/Generation 3 · Version 1/);
    expect(
      screen.queryByRole('button', { name: 'Roll back to Version 1 (generation 3)' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Roll back to Version 1 (generation 1)' }),
    ).not.toBeInTheDocument();
  });

  it('displays scoped list failures instead of presenting an empty release history', async () => {
    stubFetch({
      [`/api/v1/templates/${TEMPLATE}/candidates`]: () =>
        problem(409, 'TEMPLATE_MODE_MISMATCH', 'The requested mode does not match the session.'),
      [`/api/v1/templates/${TEMPLATE}/releases`]: () => json({ active: null, items: [] }),
    });
    mountPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The requested mode does not match the session.',
    );
    expect(screen.queryByText(/No releases yet/)).not.toBeInTheDocument();
  });

  it('opens and dismisses the rollback dialog with the keyboard at a phone viewport', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const user = userEvent.setup();
    const previous = release({ id: 'previous', generation: 1 });
    const head = release({ id: 'head', generation: 2 });
    releaseServer({ active: head, history: [head, previous] });
    mountPanel();
    const trigger = await screen.findByRole('button', {
      name: 'Roll back to Version 1 (generation 1)',
    });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Roll back release' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole('textbox', { name: /Reason/ })).toBeInTheDocument();
    expect((await axe(document.body)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Roll back release' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('disables a saved version with validation errors and says why', async () => {
    const user = userEvent.setup();
    releaseServer();
    mountPanel({
      versions: [
        VERSIONS[0],
        { ...VERSIONS[1], active: false, report: { ok: false } },
        { version: 'version-3', active: false, createdAt: 1_700_000_002_000, displayOnly: false },
      ],
    });
    await screen.findByText(/No candidates yet/);
    expect(screen.getByText(/Version 2 can't be a candidate/)).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Saved version' }));
    expect(screen.getByRole('option', { name: /Version 2 · has errors/ })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('option', { name: 'Version 3' })).not.toHaveAttribute('data-disabled');
  });

  it('keeps mutations idle while the lists refetch', async () => {
    const server = releaseServer({ candidates: [candidate()] });
    const view = mountPanel();
    const approve = await screen.findByRole('button', { name: 'Approve candidate for Version 2' });
    await act(async () => {
      void view.client.invalidateQueries();
    });
    expect(approve).toBeEnabled();
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
});
