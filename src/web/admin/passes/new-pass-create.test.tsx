import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { getMode, resetModeForTests, setMode } from '../../lib/mode.ts';
import * as motion from '../../lib/motion.ts';
import {
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '../../lib/test-utils.tsx';
import * as created from './created.tsx';
import {
  eligibleTemplate,
  INPUT_SCHEMA,
  ORG,
  passDetail,
  passSummary,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateVersionDetail,
} from './test-fixtures.ts';

const henry = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const other = membershipFixture('org2', { orgName: 'Other', orgSlug: 'other' });
// The web test target is ES2023; the test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
});
afterEach(() => {
  resetModeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openReview(options: {
  post: (init: RequestInit | undefined) => Response | Promise<Response>;
  memberships?: OrgMembership[];
  list?: (url: URL) => Response | Promise<Response>;
  templates?: (url: URL) => Response | Promise<Response>;
  selection?: (url: URL) => Record<string, unknown> | null;
  passDetail?: () => Response | Promise<Response>;
  versionDetail?: (version: string) => Response;
  sessionResponse?: () => Response | Promise<Response>;
  membershipResponse?: () => Response | Promise<Response>;
}) {
  const user = userEvent.setup();
  const eligibleFor = (url: URL) => {
    if (
      !url.searchParams.get('orgId') ||
      !url.searchParams.get('mode') ||
      url.searchParams.get('provider') !== 'apple'
    ) {
      return problem(400, 'scope_required', 'Organization, mode and Apple provider are required.');
    }
    if (options.templates) return options.templates(url);
    const choice = options.selection ? options.selection(url) : eligibleTemplate();
    return json({ items: choice ? [choice] : [], nextCursor: null });
  };
  const app = await renderApp('/admin/passes/new', {
    session: 'admin',
    memberships: options.memberships ?? [henry],
    handlers: {
      ...(options.sessionResponse ? { '/api/v1/session': options.sessionResponse } : {}),
      ...(options.membershipResponse
        ? { '/api/v1/orgs/memberships/me': options.membershipResponse }
        : {}),
      '/api/v1/templates/eligible': eligibleFor,
      '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
        options.versionDetail?.('a1b2c3d4e5f6a7b8') ?? json(templateVersionDetail()),
      '/api/v1/templates/tpl1/versions/ffeeddccbbaa9988': () =>
        options.versionDetail?.('ffeeddccbbaa9988') ??
        json(templateVersionDetail({ version: 'ffeeddccbbaa9988' })),
      '/api/v1/templates/tpl2/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1/preview': () =>
        json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
      '/api/v1/templates/tpl2/preview': () =>
        json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
      '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      '/api/v1/passes': (url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') return options.post(init);
        if (!url.searchParams.get('orgId'))
          return problem(400, 'scope_required', 'Organization is required.');
        return options.list?.(url) ?? json({ items: [], nextCursor: null });
      },
      '/api/v1/passes/p9': () => options.passDetail?.() ?? json(passDetail({ id: 'p9' })),
    },
  });
  await user.click(await screen.findByRole('radio', { name: /Henry's/ }));
  await waitFor(() => expect(app.router.state.location.search).toMatchObject({ orgId: ORG.id }));
  await waitFor(() =>
    expect(
      app.queryClient.getQueryState([
        'admin',
        'templates',
        'eligible',
        ORG.id,
        'live',
        'apple',
        'u1',
      ])?.status,
    ).toBe('success'),
  );
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(await screen.findByLabelText(/Member name/), 'Ann');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Holder email'), 'ann@example.com');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('button', { name: 'Create and send' });
  return { user, ...app };
}

describe('reviewed pass issuance', () => {
  it('sends the displayed mode and version, reuses a key only for the same intent', async () => {
    const version = 'a1b2c3d4e5f6a7b8';
    const requests: { body: Record<string, unknown>; key: string | null }[] = [];
    const { user } = await openReview({
      post: (init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get('idempotency-key'),
        });
        return problem(500, 'failure', 'Try again');
      },
    });
    expect(screen.getByText(version)).toBeInTheDocument();
    expect(screen.queryByText('release1')).toBeNull();
    expect(screen.queryByText('Release generation')).toBeNull();
    expect(screen.getByText('Wallet provider').parentElement).toHaveTextContent('Apple Wallet');
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await screen.findByText('Try again');
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.body).toEqual({
      orgId: 'org1',
      templateId: 'tpl1',
      mode: 'live',
      templateVersion: version,
      releaseId: 'release1',
      releaseGeneration: 1,
      input: { name: 'Ann' },
      holderEmail: 'ann@example.com',
      sendEmail: true,
    });
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[1]?.key).toBe(requests[0]?.key);
    act(() => setMode('test'));
    expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
    await screen.findByText(version);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.body.mode).toBe('test');
    expect(requests[2]?.key).not.toBe(requests[1]?.key);
  });
  it('issues from the eligible response without requesting the template draft', async () => {
    const requests: Record<string, unknown>[] = [];
    const { user, fetchMock } = await openReview({
      post: (init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return problem(500, 'failure', 'Try again');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      templateVersion: 'a1b2c3d4e5f6a7b8',
      releaseId: 'release1',
      releaseGeneration: 1,
    });
    expect(
      fetchMock.mock.calls.some(([url]) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        return (
          path === '/api/v1/templates' ||
          path === '/api/v1/templates/tpl1' ||
          path === '/api/v1/templates/tpl1/releases'
        );
      }),
    ).toBe(false);
  });
  it.each([409, 412])(
    'blocks a stale %s response until the updated template is reviewed',
    async (status) => {
      let version = 'a1b2c3d4e5f6a7b8';
      let generation = 1;

      const requests: { body: Record<string, unknown>; key: string | null }[] = [];
      const { user } = await openReview({
        selection: () =>
          eligibleTemplate({
            releaseId: `release${generation}`,
            releaseGeneration: generation,
            version,
          }),
        post: (init) => {
          requests.push({
            body: JSON.parse(String(init?.body)),
            key: new Headers(init?.headers).get('idempotency-key'),
          });
          version = 'ffeeddccbbaa9988';
          generation = 2;
          return problem(status, 'stale', 'Changed');
        },
      });
      await user.click(screen.getByRole('button', { name: 'Create and send' }));
      await screen.findByText(/active release, mode, or version may have changed/i);
      await screen.findByText('ffeeddccbbaa9988');
      expect(requests).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByDisplayValue('ann@example.com')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('button', { name: 'Create and send' }));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]?.body.templateVersion).toBe('ffeeddccbbaa9988');
      expect(requests[1]?.body.releaseId).toBe('release2');
      expect(requests[1]?.body.releaseGeneration).toBe(2);
      expect(requests[1]?.body.input).toEqual({ name: 'Ann' });
      expect(requests[1]?.key).not.toBe(requests[0]?.key);
    },
  );

  it('does not reuse a release removed from eligibility after a conflict', async () => {
    let removed = false;
    let reads = 0;
    let posts = 0;
    const { user, queryClient } = await openReview({
      selection: () => {
        reads += 1;
        return removed ? null : eligibleTemplate();
      },
      post: () => {
        posts += 1;
        removed = true;
        return problem(409, 'TEMPLATE_RELEASE_CONFLICT', 'Release is no longer eligible');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org1', 'live', 'apple', 'u1'])
          ?.fetchStatus,
      ).toBe('idle'),
    );
    expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Edit template' }));
    expect(
      await screen.findByText('No eligible templates for this organization and mode'),
    ).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it('revalidates fields when a replacement release changes the input schema', async () => {
    let generation = 1;
    const posts: Record<string, unknown>[] = [];
    const { user } = await openReview({
      selection: () =>
        eligibleTemplate({
          releaseId: `release${generation}`,
          releaseGeneration: generation,
          version: generation === 1 ? 'a1b2c3d4e5f6a7b8' : 'ffeeddccbbaa9988',
        }),
      versionDetail: (version) =>
        json(
          templateVersionDetail({
            version,
            manifest: {
              inputs:
                version === 'a1b2c3d4e5f6a7b8'
                  ? INPUT_SCHEMA
                  : {
                      ...INPUT_SCHEMA,
                      required: ['name', 'extra'],
                      properties: {
                        ...INPUT_SCHEMA.properties,
                        extra: { type: 'string', 'x-label': 'New required field' },
                      },
                    },
              sample: { name: 'Sam' },
            },
          }),
        ),
      post: (init) => {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        generation = 2;
        return problem(409, 'TEMPLATE_RELEASE_CONFLICT', 'Release changed');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await screen.findByText('ffeeddccbbaa9988');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText(/New required field/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    expect(posts).toHaveLength(1);
    await user.type(screen.getByLabelText(/New required field/), 'Ready');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.input).toEqual({ name: 'Ann', extra: 'Ready' });
  });

  it('requires review again when the active release generation changes without a version change', async () => {
    let generation = 1;
    const posts: Record<string, unknown>[] = [];
    const { user, queryClient } = await openReview({
      selection: () => eligibleTemplate({ releaseGeneration: generation }),
      post: (init) => {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return problem(500, 'failure', 'Try again');
      },
    });
    generation = 2;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['admin', 'templates', 'eligible', 'org1', 'live', 'apple', 'u1'],
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
    });
    expect(posts).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ releaseId: 'release1', releaseGeneration: 2 });
  });
});

describe('first pass for an organization', () => {
  it.each([
    { result: 'empty', items: [], status: 'success', first: true },
    { result: 'nonempty', items: [passSummary()], status: 'success', first: false },
    { result: 'failed', items: [], status: 'error', first: false },
  ])(
    'celebrates only a confirmed empty scoped list ($result)',
    async ({ result, items, status, first }) => {
      const marked = vi.spyOn(created, 'markCreated');
      const listRequests: URL[] = [];
      const { user, queryClient } = await openReview({
        list: (url) => {
          listRequests.push(url);
          return result === 'failed'
            ? problem(500, 'failure', 'Cannot read passes')
            : json({ items, nextCursor: null });
        },
        post: () => json(passDetail({ id: 'p9' }), 201),
      });
      await waitFor(() => {
        const state = queryClient.getQueryState([
          'admin',
          'passes',
          'first-of-org',
          ORG.id,
          'live',
          'u1',
        ]);
        expect(state?.status).toBe(status);
        expect(state?.fetchStatus).toBe('idle');
      });
      expect(listRequests.length).toBeGreaterThan(0);
      expect(listRequests.every((url) => url.searchParams.get('orgId') === ORG.id)).toBe(true);
      expect(listRequests.every((url) => url.searchParams.get('limit') === '1')).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Create and send' }));
      await waitFor(() => expect(marked).toHaveBeenCalledWith('pass:p9', { sent: true, first }));
    },
  );

  it('does not celebrate while the scoped list is still loading', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    // The web test target is ES2023, which does not expose Promise.withResolvers.
    let resolveList!: (response: Response) => void;
    const pendingList = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const posts: RequestInit[] = [];
    const { user } = await openReview({
      list: () => pendingList,
      post: (init) => {
        if (init) posts.push(init);
        return json(passDetail({ id: 'p9' }), 201);
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => resolveList(json({ items: [], nextCursor: null })));
    await waitFor(() =>
      expect(marked).toHaveBeenCalledWith('pass:p9', { sent: true, first: false }),
    );
  });

  it('does not request the pass list without passes:read', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    const listRequests: URL[] = [];
    const { user } = await openReview({
      memberships: [{ ...henry, capabilities: ['org:read', 'templates:read', 'passes:operate'] }],
      list: (url) => {
        listRequests.push(url);
        return json({ items: [], nextCursor: null });
      },
      post: () => json(passDetail({ id: 'p9' }), 201),
    });
    expect(listRequests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() =>
      expect(marked).toHaveBeenCalledWith('pass:p9', { sent: true, first: false }),
    );
    expect(listRequests).toHaveLength(0);
  });

  it('forgets a cached empty result when passes:read is revoked', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    const listRequests: URL[] = [];
    const { user, queryClient } = await openReview({
      list: (url) => {
        listRequests.push(url);
        return json({ items: [], nextCursor: null });
      },
      post: () => json(passDetail({ id: 'p9' }), 201),
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'passes', 'first-of-org', ORG.id, 'live', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...henry, capabilities: henry.capabilities.filter((c) => c !== 'passes:read') }],
      });
    });
    const count = listRequests.length;
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() =>
      expect(marked).toHaveBeenCalledWith('pass:p9', { sent: true, first: false }),
    );
    expect(listRequests).toHaveLength(count);
  });

  it('keeps the submitted payload and first-pass result when scope and mode change in flight', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    // Promise.withResolvers is not available in the ES2023 web target.
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    let resolveDetail!: (response: Response) => void;
    const pendingDetail = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    let detailRequests = 0;
    const posts: Record<string, unknown>[] = [];
    const { user, router, queryClient } = await openReview({
      memberships: [henry, other],
      list: (url) =>
        json({
          items: url.searchParams.get('orgId') === 'org2' ? [passSummary({ orgId: 'org2' })] : [],
          nextCursor: null,
        }),
      templates: (url) =>
        json({
          items:
            url.searchParams.get('orgId') === 'org2'
              ? [
                  eligibleTemplate({
                    templateId: 'tpl2',
                    templateOrgId: 'org2',
                    releaseId: 'release2',
                  }),
                ]
              : [eligibleTemplate()],
          nextCursor: null,
        }),
      passDetail: () => {
        detailRequests += 1;
        return pendingDetail;
      },
      post: (init) => {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return pendingPost;
      },
    });
    await waitFor(() => {
      const state = queryClient.getQueryState([
        'admin',
        'passes',
        'first-of-org',
        ORG.id,
        'live',
        'u1',
      ]);
      expect(state?.status).toBe('success');
      expect(state?.fetchStatus).toBe('idle');
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    act(() => setMode('test'));
    await waitFor(() => {
      const state = queryClient.getQueryState([
        'admin',
        'passes',
        'first-of-org',
        'org2',
        'test',
        'u1',
      ]);
      expect(state?.status).toBe('success');
      expect(state?.fetchStatus).toBe('idle');
    });
    await act(async () => resolvePost(json(passDetail({ id: 'p9' }), 201)));
    await waitFor(() =>
      expect(marked).toHaveBeenCalledWith('pass:p9', { sent: true, first: true }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p9'));
    expect(router.state.location.search).toMatchObject({ orgId: ORG.id });
    await waitFor(() => expect(detailRequests).toBeGreaterThan(0));
    expect(queryClient.getQueryData(['admin', 'passes', 'detail', 'p9'])).toBeUndefined();
    expect(getMode()).toBe('test');
    await act(async () => resolveDetail(json(passDetail({ id: 'p9' }))));
    expect(posts[0]).toMatchObject({
      orgId: 'org1',
      templateId: 'tpl1',
      templateVersion: 'a1b2c3d4e5f6a7b8',
      mode: 'live',
      input: { name: 'Ann' },
      holderEmail: 'ann@example.com',
      sendEmail: true,
    });
  });

  it('preserves editable fields through a same-user session and membership refresh', async () => {
    const sessionReply = deferred.withResolvers<Response>();
    const membershipReply = deferred.withResolvers<Response>();
    let deferRefresh = false;
    let sessionReloaded = false;
    let membershipReloaded = false;
    let posts = 0;
    const { user, queryClient } = await openReview({
      sessionResponse: () => {
        if (!deferRefresh) return json(sessionFixture('admin'));
        sessionReloaded = true;
        return sessionReply.promise;
      },
      membershipResponse: () => {
        if (!deferRefresh) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return problem(500, 'failure', 'Unexpected request');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    deferRefresh = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['session'], exact: true });
    });
    await waitFor(() => expect(sessionReloaded).toBe(true));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByLabelText(/Member name/), 'abelle');
    await act(async () => sessionReply.resolve(json(sessionFixture('admin'))));
    await waitFor(() => expect(membershipReloaded).toBe(true));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Annabelle');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(posts).toBe(0);
    await act(async () => membershipReply.resolve(json({ items: [henry] })));
    await waitFor(() => {
      expect(screen.getByLabelText(/Member name/)).toHaveValue('Annabelle');
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('ann@example.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Member name').parentElement).toHaveTextContent('Annabelle');
    expect(screen.getByRole('button', { name: 'Create and send' })).toBeEnabled();
  });

  it('renders only the previously released fields while eligibility and grants refresh together', async () => {
    const eligibleReply = deferred.withResolvers<Response>();
    const membershipReply = deferred.withResolvers<Response>();
    let deferEligible = false;
    let eligibleReloaded = false;
    let deferMembership = false;
    let membershipReloaded = false;
    let selectedRelease = eligibleTemplate();
    let newVersionReads = 0;
    const { user, queryClient } = await openReview({
      templates: () => {
        if (!deferEligible) {
          return json({
            items: [selectedRelease],
            nextCursor: null,
          });
        }
        eligibleReloaded = true;
        return eligibleReply.promise;
      },
      membershipResponse: () => {
        if (!deferMembership) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      versionDetail: (version) => {
        if (version !== 'ffeeddccbbaa9988') return json(templateVersionDetail());
        newVersionReads += 1;
        return json(
          templateVersionDetail({
            version,
            manifest: {
              inputs: {
                type: 'object',
                required: ['name', 'extra'],
                properties: {
                  name: { type: 'string', 'x-label': 'Member name' },
                  extra: { type: 'string', 'x-label': 'New required field' },
                },
              },
              sample: {},
            },
          }),
        );
      },
      post: () => problem(500, 'failure', 'Unexpected request'),
    });
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    deferEligible = true;
    act(() => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'templates', 'eligible', 'org1', 'live', 'apple', 'u1'],
      });
    });
    await waitFor(() => expect(eligibleReloaded).toBe(true));
    deferMembership = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
    });
    await waitFor(() => expect(membershipReloaded).toBe(true));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    selectedRelease = eligibleTemplate({ releaseGeneration: 2, version: 'ffeeddccbbaa9988' });
    await act(async () =>
      eligibleReply.resolve(json({ items: [selectedRelease], nextCursor: null })),
    );
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByLabelText(/New required field/)).toBeNull();
    expect(newVersionReads).toBe(0);
    deferEligible = false;
    await act(async () => membershipReply.resolve(json({ items: [henry] })));
    expect(await screen.findByLabelText(/New required field/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });
  });

  it('discards the visible draft when a membership refresh confirms revocation', async () => {
    const membershipReply = deferred.withResolvers<Response>();
    let refreshing = false;
    let membershipReloaded = false;
    let posts = 0;
    const { user, queryClient } = await openReview({
      membershipResponse: () => {
        if (!refreshing) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return problem(500, 'failure', 'Unexpected request');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    refreshing = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
    });
    await waitFor(() => expect(membershipReloaded).toBe(true));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await act(async () => membershipReply.resolve(json({ items: [] })));
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
    expect(screen.queryByText('ann@example.com')).toBeNull();
    expect(posts).toBe(0);

    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], { items: [henry] });
    });
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText(/Member name/)).toHaveValue('');
  });

  it('discards the previous principal’s draft when a pending session resolves to another user', async () => {
    const sessionReply = deferred.withResolvers<Response>();
    let refreshing = false;
    let sessionReloaded = false;
    let principal = 'u1';
    const { user, queryClient } = await openReview({
      sessionResponse: () => {
        if (!refreshing) return json(sessionFixture('admin'));
        sessionReloaded = true;
        return sessionReply.promise;
      },
      membershipResponse: () => json({ items: [{ ...henry, userId: principal }] }),
      post: () => problem(500, 'failure', 'Unexpected request'),
    });
    await user.click(screen.getByRole('button', { name: 'Edit member name' }));
    refreshing = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['session'], exact: true });
    });
    await waitFor(() => expect(sessionReloaded).toBe(true));
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
    const nextSession = sessionFixture('admin');
    if (!nextSession.authenticated) throw new Error('Expected an authenticated fixture');
    principal = 'u2';
    await act(async () =>
      sessionReply.resolve(json({ ...nextSession, user: { ...nextSession.user, id: 'u2' } })),
    );
    await waitFor(() => expect(screen.queryByDisplayValue('Ann')).toBeNull());
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const name = await screen.findByLabelText(/Member name/);
    expect(name).toHaveValue('');
    await user.type(name, 'Beth');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('');
  });

  it.each(['org2', 'foreign'])(
    'masks and resets the old draft when scope changes to %s during a grant refresh',
    async (nextOrgId) => {
      const membershipReply = deferred.withResolvers<Response>();
      let refreshing = false;
      let membershipReloaded = false;
      const { user, router, queryClient } = await openReview({
        memberships: [henry, other],
        membershipResponse: () => {
          if (!refreshing) return json({ items: [henry, other] });
          membershipReloaded = true;
          return membershipReply.promise;
        },
        selection: (url) => eligibleTemplate({ templateOrgId: url.searchParams.get('orgId') }),
        post: () => problem(500, 'failure', 'Unexpected request'),
      });
      await user.click(screen.getByRole('button', { name: 'Edit member name' }));
      refreshing = true;
      act(() => {
        void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
      });
      await waitFor(() => expect(membershipReloaded).toBe(true));
      expect(screen.getByLabelText(/Member name/)).toHaveValue('Ann');
      await act(async () => {
        await router.navigate({
          to: '/admin/passes/new',
          search: { orgId: nextOrgId },
          ignoreBlocker: true,
        });
      });
      await waitFor(() => expect(screen.queryByLabelText(/Member name/)).toBeNull());
      await act(async () => membershipReply.resolve(json({ items: [henry, other] })));
      if (nextOrgId === 'foreign') {
        expect(
          await screen.findByRole('heading', { name: 'You do not have access' }),
        ).toBeInTheDocument();
        return;
      }
      await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(await screen.findByLabelText(/Member name/)).toHaveValue('');
    },
  );

  it('waits for current organization grants before submitting the reviewed release', async () => {
    const membershipReply = deferred.withResolvers<Response>();
    let deferMembership = false;
    let membershipReloaded = false;
    let posts = 0;
    const { user, queryClient } = await openReview({
      membershipResponse: () => {
        if (!deferMembership) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return problem(500, 'failure', 'Try again');
      },
    });
    deferMembership = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
    });
    await waitFor(() => expect(membershipReloaded).toBe(true));
    expect(screen.getByText('Member name').parentElement).toHaveTextContent('Ann');
    expect(screen.getByRole('button', { name: 'Edit holder' }).parentElement).toHaveTextContent(
      'ann@example.com',
    );
    expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect(posts).toBe(0);
    await act(async () => membershipReply.resolve(json({ items: [henry] })));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
  });

  it('settles a successful create after an in-flight same-user session refresh', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    const sessionReply = deferred.withResolvers<Response>();
    const membershipReply = deferred.withResolvers<Response>();
    const postReply = deferred.withResolvers<Response>();
    let deferSession = false;
    let sessionReloaded = false;
    let membershipReloaded = false;
    let posts = 0;
    const { user, router, queryClient } = await openReview({
      sessionResponse: () => {
        if (!deferSession) return json(sessionFixture('admin'));
        sessionReloaded = true;
        return sessionReply.promise;
      },
      membershipResponse: () => {
        if (!deferSession) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return postReply.promise;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
    deferSession = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['session'], exact: true });
    });
    await waitFor(() => expect(sessionReloaded).toBe(true));
    await act(async () => postReply.resolve(json(passDetail({ id: 'p9' }), 201)));
    expect(marked).not.toHaveBeenCalled();
    await act(async () => sessionReply.resolve(json(sessionFixture('admin'))));
    await waitFor(() => expect(membershipReloaded).toBe(true));
    expect(marked).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/admin/passes/new');
    await act(async () => membershipReply.resolve(json({ items: [henry] })));
    await waitFor(() => expect(marked).toHaveBeenCalledWith('pass:p9', expect.anything()));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p9'));
  });

  it('retains a pending release conflict until fresh grants allow revalidation', async () => {
    const membershipReply = deferred.withResolvers<Response>();
    const postReply = deferred.withResolvers<Response>();
    let refreshing = false;
    let membershipReloaded = false;
    let reads = 0;
    let posts = 0;
    const { user, queryClient } = await openReview({
      selection: () => {
        reads += 1;
        return eligibleTemplate();
      },
      membershipResponse: () => {
        if (!refreshing) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return postReply.promise;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
    const previousReads = reads;
    refreshing = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
    });
    await waitFor(() => expect(membershipReloaded).toBe(true));
    await act(async () => postReply.resolve(problem(409, 'stale', 'Changed')));
    expect(reads).toBe(previousReads);
    expect(screen.getByText('Member name').parentElement).toHaveTextContent('Ann');
    await act(async () => membershipReply.resolve(json({ items: [henry] })));
    await screen.findByText(/active release, mode, or version may have changed/i);
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org1', 'live', 'apple', 'u1'])
          ?.fetchStatus,
      ).toBe('idle');
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
    });
    expect(reads).toBeGreaterThan(previousReads);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Create and send' })).toBeEnabled();
  });

  it('denies the wizard if grants are revoked while a create is settling', async () => {
    const membershipReply = deferred.withResolvers<Response>();
    const postReply = deferred.withResolvers<Response>();
    let refreshing = false;
    let membershipReloaded = false;
    let posts = 0;
    const { user, router, queryClient } = await openReview({
      membershipResponse: () => {
        if (!refreshing) return json({ items: [henry] });
        membershipReloaded = true;
        return membershipReply.promise;
      },
      post: () => {
        posts += 1;
        return postReply.promise;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
    refreshing = true;
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['org-memberships', 'me'] });
    });
    await waitFor(() => expect(membershipReloaded).toBe(true));
    await act(async () => postReply.resolve(json(passDetail({ id: 'p9' }), 201)));
    expect(router.state.location.pathname).toBe('/admin/passes/new');
    await act(async () => membershipReply.resolve(json({ items: [] })));
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(router.state.location.pathname).toBe('/admin/passes/new');
    expect(screen.queryByText('ann@example.com')).toBeNull();
  });

  it.each([201, 409])(
    'suppresses a pending user A result after switching to user B (%s)',
    async (status) => {
      const marked = vi.spyOn(created, 'markCreated');
      const minted = vi.spyOn(motion, 'markMinted');
      // Promise.withResolvers is not available in the ES2023 web target.
      let resolvePost!: (response: Response) => void;
      const pendingPost = new Promise<Response>((resolve) => {
        resolvePost = resolve;
      });
      let posts = 0;
      let releaseReads = 0;
      const { user, router, queryClient } = await openReview({
        selection: () => {
          releaseReads += 1;
          return eligibleTemplate();
        },
        post: () => {
          posts += 1;
          return pendingPost;
        },
      });
      await user.click(screen.getByRole('button', { name: 'Create and send' }));
      await waitFor(() => expect(posts).toBe(1));
      const replacement = sessionFixture('admin');
      if (!replacement.authenticated) throw new Error('Expected an authenticated fixture');
      act(() => {
        queryClient.setQueryData(['session'], {
          ...replacement,
          user: { ...replacement.user, id: 'u2' },
        });
      });
      const readsBeforeCompletion = releaseReads;
      await act(async () => {
        resolvePost(
          status === 201
            ? json(passDetail({ id: 'p9' }), 201)
            : problem(409, 'TEMPLATE_RELEASE_CONFLICT', 'Changed'),
        );
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(queryClient.getQueryData(['admin', 'passes', 'detail', 'p9'])).toBeUndefined();
      expect(router.state.location.pathname).toBe('/admin/passes/new');
      expect(marked).not.toHaveBeenCalled();
      expect(minted).not.toHaveBeenCalled();
      expect(releaseReads).toBe(readsBeforeCompletion);
    },
  );

  it('rechecks the principal after an in-flight success invalidation', async () => {
    const marked = vi.spyOn(created, 'markCreated');
    const minted = vi.spyOn(motion, 'markMinted');
    // Promise.withResolvers is not available in the ES2023 web target.
    let resolveList!: (response: Response) => void;
    const pendingList = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    let blockRefetch = false;
    let waitingForList = false;
    const { user, router, queryClient } = await openReview({
      list: () => {
        if (!blockRefetch) return json({ items: [], nextCursor: null });
        waitingForList = true;
        return pendingList;
      },
      post: () => json(passDetail({ id: 'p9' }), 201),
    });
    await waitFor(() => {
      const state = queryClient.getQueryState([
        'admin',
        'passes',
        'first-of-org',
        ORG.id,
        'live',
        'u1',
      ]);
      expect(state?.status).toBe('success');
      expect(state?.fetchStatus).toBe('idle');
    });
    blockRefetch = true;
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(waitingForList).toBe(true));
    const replacement = sessionFixture('admin');
    if (!replacement.authenticated) throw new Error('Expected an authenticated fixture');
    act(() => {
      queryClient.setQueryData(['session'], {
        ...replacement,
        user: { ...replacement.user, id: 'u2' },
      });
    });
    await act(async () => resolveList(json({ items: [], nextCursor: null })));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(queryClient.getQueryData(['admin', 'passes', 'detail', 'p9'])).toBeUndefined();
    expect(router.state.location.pathname).toBe('/admin/passes/new');
    expect(marked).not.toHaveBeenCalled();
    expect(minted).not.toHaveBeenCalled();
  });

  it('does not navigate to a pass after its organization is revoked in flight', async () => {
    // Promise.withResolvers is not available in the ES2023 web target.
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    let posts = 0;
    const { user, router, queryClient } = await openReview({
      memberships: [henry, other],
      post: () => {
        posts += 1;
        return pendingPost;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org2', 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...henry, revokedAt: 1_700_000_000_001 }, other],
      });
    });
    await act(async () => resolvePost(json(passDetail({ id: 'p9' }), 201)));
    expect(router.state.location.pathname).toBe('/admin/passes/new');
    expect(screen.queryByText('ann@example.com')).toBeNull();
    expect(queryClient.getQueryData(['admin', 'passes', 'detail', 'p9'])).toBeUndefined();
  });
});

describe('organization authority while issuing', () => {
  it.each(['capability', 'revoked', 'removed'] as const)(
    'cannot submit a reviewed pass after the selected membership changes: %s',
    async (change) => {
      const posts: RequestInit[] = [];
      const { queryClient } = await openReview({
        memberships: [henry, other],
        post: (init) => {
          if (init) posts.push(init);
          return problem(500, 'failure', 'Unexpected request');
        },
      });
      act(() => {
        const changed =
          change === 'removed'
            ? [other]
            : [
                change === 'revoked'
                  ? { ...henry, revokedAt: 1_700_000_000_001 }
                  : { ...henry, capabilities: ['org:read', 'passes:read'] },
                other,
              ];
        queryClient.setQueryData(['org-memberships', 'me'], { items: changed });
      });
      await waitFor(() => {
        const button = screen.queryByRole('button', { name: 'Create and send' });
        expect(!button || button.hasAttribute('disabled')).toBe(true);
      });
      expect(posts).toHaveLength(0);
    },
  );

  it('blocks a reviewed pass when template-read permission is revoked', async () => {
    const posts: RequestInit[] = [];
    let detailRequests = 0;
    const { user, queryClient } = await openReview({
      selection: () => {
        detailRequests += 1;
        return eligibleTemplate();
      },
      post: (init) => {
        if (init) posts.push(init);
        return problem(500, 'failure', 'Unexpected request');
      },
    });
    const previousRequests = detailRequests;
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [
          { ...henry, capabilities: henry.capabilities.filter((c) => c !== 'templates:read') },
        ],
      });
    });
    expect(
      await screen.findByText('You need permission to view templates for this organization.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create pass' })).toBeDisabled());
    expect(detailRequests).toBe(previousRequests);
    expect(posts).toHaveLength(0);
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], { items: [henry] });
    });
    await user.click(await screen.findByRole('button', { name: 'Edit member name' }));
    const name = await screen.findByLabelText(/Member name/);
    expect(name).toHaveValue('');
    await user.type(name, 'Beth');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('');
  });

  it('does not refetch a former org template when an old create conflicts', async () => {
    // The web test target is ES2023, which does not expose Promise.withResolvers.
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    let detailRequests = 0;
    let posts = 0;
    const { user, router, queryClient } = await openReview({
      memberships: [henry, other],
      selection: () => {
        detailRequests += 1;
        return eligibleTemplate();
      },
      post: () => {
        posts += 1;
        return pendingPost;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toBe(1));
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org2', 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    const previousRequests = detailRequests;
    await act(async () => resolvePost(problem(409, 'stale', 'Changed')));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(detailRequests).toBe(previousRequests);
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
  });

  it('clears the old template on an organization change and submits only the newly reviewed org', async () => {
    const posts: Record<string, unknown>[] = [];
    const { user, router, queryClient } = await openReview({
      memberships: [henry, other],
      templates: (url) => {
        const orgId = url.searchParams.get('orgId');
        return json({
          items: [
            orgId === 'org2'
              ? eligibleTemplate({
                  templateId: 'tpl2',
                  templateOrgId: 'org2',
                  releaseId: 'release2',
                })
              : eligibleTemplate(),
          ],
          nextCursor: null,
        });
      },
      post: (init) => {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return problem(500, 'failure', 'Try again');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Edit organization' }));
    await user.click(await screen.findByRole('radio', { name: /Other/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org2', 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const choice = await screen.findByRole('radio', { name: /Copper card/ });
    expect(choice).not.toBeChecked();
    expect(posts).toHaveLength(0);
    await user.click(choice);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText(/Member name/), 'Beth');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Email the pass' })).not.toBeChecked();
    await user.type(screen.getByLabelText('Holder email'), 'beth@example.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.orgId).toBe('org2');
    expect(posts[0]?.holderEmail).toBe('beth@example.com');
    expect(posts[0]?.sendEmail).toBe(true);
    expect(posts[0]?.input).toEqual({ name: 'Beth' });
  });

  it('clears the draft when the shell switches to another organization', async () => {
    const { user, router } = await openReview({
      memberships: [henry, other],
      templates: (url) =>
        json({
          items:
            url.searchParams.get('orgId') === 'org2'
              ? [
                  eligibleTemplate({
                    templateId: 'tpl2',
                    templateOrgId: 'org2',
                    releaseId: 'release2',
                  }),
                ]
              : [eligibleTemplate()],
          nextCursor: null,
        }),
      post: () => problem(500, 'failure', 'Unexpected request'),
    });
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    const template = await screen.findByRole('radio', { name: /Copper card/ });
    expect(template).not.toBeChecked();
    await user.click(template);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const name = await screen.findByLabelText(/Member name/);
    expect(name).toHaveValue('');
    await user.type(name, 'Beth');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Email the pass' })).not.toBeChecked();
  });
});
