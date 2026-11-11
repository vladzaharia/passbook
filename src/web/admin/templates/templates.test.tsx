import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, problem, renderApp } from '../../lib/test-utils.tsx';
import { markCreated } from '../passes/created.tsx';
import {
  ORG,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';
import { importPolling } from './api.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const orgs = () => json({ items: [ORG], nextCursor: null });
const directoryOrgs = () =>
  json({
    items: [
      { ...ORG, name: 'Outdated directory name' },
      { ...ORG, id: 'org2', slug: 'outside', name: 'Outside organization' },
    ],
    nextCursor: null,
  });
const preview = () =>
  json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] });
const orgAccess = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};
const otherMembership = membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' });
const bothOrgs = { memberships: [...orgAccess.memberships, otherMembership], selectedOrg: ORG.id };

// Preview requests are batched in module state: one test's must not fire in the next.
afterEach(clearPreviewBatches);

describe('templates list', () => {
  it('keeps the library readable without authoring controls or upload queries', async () => {
    const { fetchMock } = await renderApp('/admin/templates', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:review'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(await screen.findByRole('link', { name: 'Copper card' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upload template' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/templates/uploads'))).toBe(
      false,
    );
  });

  it('marks baked templates and sends the origin filter', async () => {
    const seen: URL[] = [];
    await renderApp('/admin/templates?origin=baked', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({
            items: [
              templateSummary({
                id: 'b1',
                name: 'Starter',
                origin: 'baked',
                orgId: null,
                orgName: null,
                passCount: 0,
              }),
              templateSummary(),
            ],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'Starter' })).toHaveAttribute(
      'href',
      '/admin/templates/b1?orgId=org1',
    );
    expect(screen.getAllByText('Built-in').length).toBeGreaterThan(0);
    expect(screen.queryByText('Baked')).toBeNull();
    expect(seen[0]?.searchParams.get('origin')).toBe('baked');
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
    expect(screen.getByText(`2 templates in ${ORG.name}`)).toBeInTheDocument();
  });

  it('pages by cursor, 50 at a time, with Load more', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    await renderApp('/admin/templates', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return url.searchParams.get('cursor') === 'next'
            ? json({ items: [templateSummary({ id: 't2', name: 'Second' })], nextCursor: null })
            : json({ items: [templateSummary()], nextCursor: 'next' });
        },
      },
    });
    expect(await screen.findByText(`1 template in ${ORG.name}`)).toBeInTheDocument();
    expect(seen[0]?.searchParams.get('limit')).toBe('50');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Second' })).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('cursor')).toBe('next');
    expect(screen.getByText(`2 templates in ${ORG.name}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('does not show the previous organization’s templates while the new list is loading', async () => {
    const user = userEvent.setup();
    const requested: (string | null)[] = [];
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const secondList = deferred.withResolvers<Response>();
    const { router } = await renderApp('/admin/templates', {
      session: 'admin',
      memberships: [
        ...orgAccess.memberships,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/uploads': () => json({ items: [] }),
        '/api/v1/templates': (url) => {
          const orgId = url.searchParams.get('orgId');
          requested.push(orgId);
          if (orgId === 'org2') return secondList.promise;
          if (orgId !== ORG.id) return problem(403, 'forbidden', 'Unexpected organization.');
          return json({
            items: [templateSummary({ id: 't1', name: 'First organization card' })],
            nextCursor: null,
          });
        },
      },
    });
    expect(
      await screen.findByRole('link', { name: 'First organization card' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    await waitFor(() => expect(router.state.location.search.orgId).toBe('org2'));
    await waitFor(() => expect(requested).toContain('org2'));
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'First organization card' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('link', { name: 'Second organization card' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Loading templates')).toBeInTheDocument();

    await act(async () => {
      secondList.resolve(
        json({
          items: [
            templateSummary({
              id: 't2',
              orgId: 'org2',
              orgName: 'Second',
              name: 'Second organization card',
            }),
          ],
          nextCursor: null,
        }),
      );
    });
    expect(
      await screen.findByRole('link', { name: 'Second organization card' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'First organization card' })).not.toBeInTheDocument();
    expect(requested).toContain(ORG.id);
    expect(requested.every((orgId) => orgId === ORG.id || orgId === 'org2')).toBe(true);
  });

  it('searches by name and shows an Updated column in the table view', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/templates?view=table', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({
            items: [templateSummary({ orgId: null, orgName: null })],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('columnheader', { name: 'Updated' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Copper card' })).toHaveAttribute(
      'href',
      '/admin/templates/tpl1?orgId=org1',
    );
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'henry');
    await waitFor(() => expect(seen.at(-1)?.searchParams.get('q')).toBe('henry'));
    expect((router.state.location.search as { q?: string }).q).toBe('henry');
  });

  it('adds includeArchived when asked and keeps it in the URL', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    const { router } = await renderApp('/admin/templates', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({ items: [templateSummary()], nextCursor: null });
        },
      },
    });
    await user.click(await screen.findByRole('combobox', { name: /Archived/ }));
    await user.click(await screen.findByRole('option', { name: 'Shown' }));
    await waitFor(() => expect(seen.at(-1)?.searchParams.get('includeArchived')).toBe('true'));
    expect((router.state.location.search as { archived?: boolean }).archived).toBe(true);
  });

  it('leads with recent uploads while one failed today, else keeps them under the gallery', async () => {
    const upload = (status: string, createdAt: number) => ({
      uploadId: '01a19a05-0000-7000-8000-000000000001',
      name: 'Broken.zip',
      status,
      templateId: null,
      version: null,
      error: null,
      issues: 1,
      createdAt,
    });
    let items = [upload('errored', Date.now() - 60_000)];
    const handlers = {
      '/api/v1/orgs': orgs,
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/uploads': () => json({ items }),
    };
    const first = await renderApp('/admin/templates', { session: 'admin', ...orgAccess, handlers });
    const strip = await screen.findByRole('list', { name: 'Recent uploads' });
    const gallery = screen.getByRole('link', { name: 'Copper card' });
    // Before the gallery in document order.
    expect(strip.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    first.unmount();
    items = [upload('errored', Date.now() - 2 * 86_400_000)];
    await renderApp('/admin/templates', { session: 'admin', ...orgAccess, handlers });
    const later = await screen.findByRole('list', { name: 'Recent uploads' });
    const card = screen.getByRole('link', { name: 'Copper card' });
    expect(later.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/templates', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      },
    });
    await screen.findByRole('link', { name: 'Copper card' });
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('template detail', () => {
  it.each([false, true])(
    'refetches cached ownership when explicit scope is removed (denied=%s)',
    async (denied) => {
      let moved = false;
      let reads = 0;
      let resolve!: (response: Response) => void;
      // The web target is ES2023, before Promise.withResolvers.
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      const { router } = await renderApp('/admin/templates/tpl1', {
        session: 'admin',
        ...bothOrgs,
        handlers: {
          '/api/v1/templates/tpl1': () => {
            reads += 1;
            // A body reads once; each request gets its own copy.
            return moved
              ? pending.then((r) => r.clone())
              : json(templateDetail({ name: 'Former card' }));
          },
          '/api/v1/templates/previews': previewsHandler,
        },
      });
      await screen.findByRole('heading', { name: 'Former card' });
      moved = true;
      await act(async () => {
        await router.navigate({
          to: '/admin/templates/$templateId',
          params: { templateId: 'tpl1' },
          search: { orgId: undefined },
        });
      });
      await waitFor(() => expect(reads).toBeGreaterThan(1));
      expect(screen.queryByText('Former card')).toBeNull();
      expect(router.state.location.search).not.toHaveProperty('orgId');
      await act(async () => {
        resolve(
          denied
            ? problem(403, 'forbidden', 'Forbidden.')
            : json(templateDetail({ orgId: 'org2', orgName: 'Harbor', name: 'Moved card' })),
        );
      });
      if (denied) {
        expect(
          await screen.findByRole('heading', { name: 'Choose an organization' }),
        ).toBeInTheDocument();
        expect(router.state.location.search).not.toHaveProperty('orgId');
      } else {
        expect(await screen.findByRole('heading', { name: 'Moved card' })).toBeInTheDocument();
        await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
      }
      expect(screen.queryByText('Former card')).toBeNull();
    },
  );

  it('canonicalizes a bare detail link to its actual authorized organization', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    const { router } = await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: bothOrgs.memberships,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: 'org2', orgName: 'Harbor', name: 'Harbor card' })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Harbor card' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    const href = screen.getByRole('link', { name: 'New pass' }).getAttribute('href') ?? '';
    expect(new URL(href, 'http://localhost').searchParams.get('orgId')).toBe('org2');
  });

  it('requires a selection before showing a shared template', async () => {
    localStorage.removeItem('wallet-org-filter');
    const user = userEvent.setup();
    let previews = 0;
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: bothOrgs.memberships,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: null, orgName: null, name: 'Shared card' })),
        '/api/v1/templates/previews': (url) => {
          previews += 1;
          return previewsHandler(url);
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Shared card')).toBeNull();
    expect(previews).toBe(0);
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByRole('heading', { name: 'Shared card' })).toBeInTheDocument();
  });

  it('asks for a new explicit choice after a bare shared read is forbidden', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    const user = userEvent.setup();
    const requested: (string | null)[] = [];
    const { router } = await renderApp('/admin/templates/tpl1', {
      session: 'user',
      memberships: bothOrgs.memberships,
      handlers: {
        '/api/v1/templates/tpl1': (url) => {
          const orgId = url.searchParams.get('orgId');
          requested.push(orgId);
          return orgId === 'org2'
            ? json(templateDetail({ orgId: null, orgName: null, name: 'Shared card' }))
            : problem(403, 'forbidden', 'Forbidden.');
        },
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(requested.every((orgId) => orgId === null)).toBe(true);
    expect(screen.queryByText('Shared card')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByRole('heading', { name: 'Shared card' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    expect(requested).toContain('org2');
    expect(requested).not.toContain(ORG.id);
  });

  it('preserves read-only detail and reports without authoring or publishing controls', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:review'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Copper card' });
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Design' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change organization' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(await screen.findByRole('button', { name: 'Report for Version 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate Version 2' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('offers archive to a publisher without granting author actions', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'user',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:publish'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Copper card' });
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Upload version' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: 'Versions' }));
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.queryByText('Requires an approved release.')).toBeNull();
  });

  it('hides another member organization’s template and never requests its preview', async () => {
    let previews = 0;
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: 'org2', orgName: 'Harbor', name: 'Private template' })),
        '/api/v1/templates/previews': (url) => {
          previews += 1;
          return previewsHandler(url);
        },
        '/api/v1/templates/tpl1/preview': () => {
          previews += 1;
          return preview();
        },
      },
    });
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Private template')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Versions' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(previews).toBe(0);
  });

  it('unmounts the current template when the selected organization changes', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Copper card' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Copper card')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Versions' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
  });

  it('keeps a shared template available and scopes its new-pass link after a switch', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: null, orgName: null, name: 'Shared card' })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await screen.findByRole('heading', { name: 'Shared card' });
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => {
      const href = screen.getByRole('link', { name: 'New pass' }).getAttribute('href') ?? '';
      expect(new URL(href, 'http://localhost').searchParams.get('orgId')).toBe('org2');
    });
    expect(screen.getByRole('heading', { name: 'Shared card' })).toBeInTheDocument();
  });

  it('labels the active version and the newest draft apart, and the import by its own version', async () => {
    markCreated('template:tpl1', 'version');
    markCreated('template:tpl1:version', 'ffeeddccbbaa9988');
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Version 1' })).toBeInTheDocument();
    expect(screen.getByText('Active version')).toBeInTheDocument();
    expect(screen.getByText(/Latest draft:/).parentElement).toHaveTextContent(
      'Latest draft: Version 2',
    );
    // The upload made version 2 while version 1 is live: the callout names version 2.
    expect(await screen.findByText('Version 2 imported')).toBeInTheDocument();
  });

  it('previews an inactive candidate when no active version exists', async () => {
    const first = templateDetail().versions[0]!;
    const requests: unknown[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ activeVersion: null, versions: [{ ...first, active: false }] })),
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return preview();
        },
      },
    });
    expect((await screen.findAllByText('Latest draft')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'No active version' })).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    await waitFor(() =>
      expect(requests).toMatchObject([{ version: first.version, orgId: ORG.id }]),
    );
  });

  it('shows versions with issue counts and the selected validation report', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Versions' }));
    expect(await screen.findByText('Missing @3x icon.')).toBeInTheDocument();
    expect(screen.queryByText('Legacy active version')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Report for Version 2' }));
    expect(await screen.findByText('Duplicate key.')).toBeInTheDocument();
    expect(screen.getByText('generic.primaryFields')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
  });

  it('has no Activate control; a valid version is released through candidates', async () => {
    const user = userEvent.setup();
    const detail = templateDetail();
    detail.versions[1] = {
      ...detail.versions[1],
      report: { ok: true, issues: [] },
    } as (typeof detail.versions)[1];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(detail),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Versions' }));
    await screen.findByRole('button', { name: 'Report for Version 2' });
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.queryByText(/Requires an approved release/)).toBeNull();
  });

  it('offers New pass and Duplicate on built-in templates, and no delete', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/templates/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': directoryOrgs,
        '/api/v1/templates/b1': () =>
          json(templateDetail({ id: 'b1', origin: 'baked', orgId: null })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/b1/preview': preview,
        '/api/v1/templates/b1/clone': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(templateDetail({ id: 'copy1', name: 'Copy' }), 201);
        },
        '/api/v1/templates/copy1': () => json(templateDetail({ id: 'copy1', name: 'Copy' })),
        '/api/v1/templates/copy1/preview': preview,
      },
    });
    const newPassLink = await screen.findByRole('link', { name: 'New pass' });
    const newPassUrl = new URL(newPassLink.getAttribute('href') ?? '', 'http://localhost');
    expect(newPassUrl.pathname).toBe('/admin/passes/new');
    expect(Object.fromEntries(newPassUrl.searchParams)).toEqual({
      orgId: ORG.id,
      templateId: 'b1',
    });
    const passesUrl = new URL(
      screen.getByRole('link', { name: /2 passes/ }).getAttribute('href') ?? '',
      'http://localhost',
    );
    expect(passesUrl.pathname).toBe('/admin/passes');
    expect(Object.fromEntries(passesUrl.searchParams)).toEqual({ templateId: 'b1', orgId: ORG.id });
    expect(screen.queryByText(/Customize|Any org/)).toBeNull();
    // Nothing in More shows from md up on a built-in, so More itself is phone-only.
    expect(screen.getByRole('button', { name: 'More' }).parentElement).toHaveClass('md:hidden');
    // More holds only what the bar hides on a phone: no upload, archive or delete.
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: /Delete|Archive|Upload version/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate template' });
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    expect(await within(dialog).findByText('Choose an organization.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /Organization/ }));
    const choice = await screen.findByRole('option', { name: ORG.name });
    expect(screen.queryByRole('option', { name: 'Outside organization' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Outdated directory name' }),
    ).not.toBeInTheDocument();
    await user.click(choice);
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: 'org1', name: 'Copper card copy' }]));
  });

  it('opens a duplicate in the destination author membership rather than the old scope', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { router } = await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/tpl1/clone': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(
            templateDetail({ id: 'copy1', orgId: 'org2', orgName: 'Harbor', name: 'Harbor copy' }),
            201,
          );
        },
        '/api/v1/templates/copy1': () =>
          json(
            templateDetail({ id: 'copy1', orgId: 'org2', orgName: 'Harbor', name: 'Harbor copy' }),
          ),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate template' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('heading', { name: 'Harbor copy' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    expect(bodies).toEqual([{ orgId: 'org2', name: 'Copper card copy' }]);
  });

  it('assigns the organization and shows the conflict as the form error', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let conflict = true;
    await renderApp('/admin/templates/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': directoryOrgs,
        '/api/v1/templates/b1': (_u, init) => {
          if (method(init) === 'PATCH') {
            bodies.push(JSON.parse(String(init?.body)));
            if (conflict)
              return problem(
                409,
                'TEMPLATE_USED_BY_OTHER_ORG',
                'Passes of another organization use this template. Reissue or delete them first.',
              );
            return json(templateDetail({ id: 'b1', origin: 'baked', orgId: 'org1' }));
          }
          return json(templateDetail({ id: 'b1', origin: 'baked', orgId: null, orgName: null }));
        },
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/b1/preview': preview,
      },
    });
    expect(
      await within(await screen.findByRole('main')).findByText('All organizations'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change organization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change organization' });
    const select = within(dialog).getByRole('combobox', { name: 'Organization' });
    expect(select).toHaveTextContent('All organizations');
    await user.click(select);
    const choice = await screen.findByRole('option', { name: ORG.name });
    expect(screen.queryByRole('option', { name: 'Outside organization' })).not.toBeInTheDocument();
    await user.click(choice);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Passes of another organization/)).toBeInTheDocument();
    conflict = false;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: 'org1' }, { orgId: 'org1' }]));
  });

  it('limits reassignment choices to author memberships and selects the resulting org', async () => {
    const user = userEvent.setup();
    let current = templateDetail();
    const { router } = await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: [
        ...bothOrgs.memberships,
        membershipFixture('org3', { orgName: 'Reviewer', capabilities: ['templates:read'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': (_url, init) => {
          if (method(init) === 'PATCH') {
            current = templateDetail({ orgId: 'org2', orgName: 'Harbor' });
          }
          return json(current);
        },
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Change organization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change organization' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Organization' }));
    expect(await screen.findByRole('option', { name: 'All organizations' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Reviewer' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Harbor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    const link = await screen.findByRole('link', { name: 'New pass' });
    const href = link.getAttribute('href') ?? '';
    expect(new URL(href, 'http://localhost').searchParams.get('orgId')).toBe('org2');
  });

  it('allows a tenant author to duplicate but not mutate a shared template', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'user',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: null, orgName: null, name: 'Shared card' })),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Shared card' });
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change organization' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Upload version' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('archives with the count sentence, then restores a never-released template', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let archived = false;
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/tpl1': () =>
          json(
            templateDetail({
              passCount: 4,
              status: archived ? 'archived' : 'active',
              restorable: archived,
            }),
          ),
        '/api/v1/templates/tpl1/archive': () => {
          calls.push('archive');
          archived = true;
          return json(templateDetail({ passCount: 4, status: 'archived', restorable: true }));
        },
        '/api/v1/templates/tpl1/restore': () => {
          calls.push('restore');
          archived = false;
          return json(templateDetail({ passCount: 4 }));
        },
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    // Passes use it: Archive, not Delete.
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: /^Archive .+\?$/ });
    expect(dialog).toHaveTextContent('New passes cannot use it. 4 existing passes keep working.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(restore).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await user.click(restore);
    expect(await screen.findByText('Template restored')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull());
    expect(calls).toEqual(['archive', 'restore']);
  });

  it('points a released archived template to the Releases rollback instead of Restore', async () => {
    const calls: string[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ passCount: 4, status: 'archived', restorable: false })),
        '/api/v1/templates/tpl1/restore': () => {
          calls.push('restore');
          return json(templateDetail());
        },
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByText(/Restore it with a rollback in Releases/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('offers a platform admin Restore on a restorable shared template', async () => {
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () =>
          json(
            templateDetail({ orgId: null, orgName: null, status: 'archived', restorable: true }),
          ),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByText(/Ask a platform admin/)).toBeNull();
  });

  it('shows an archived template without a restore action to a reader', async () => {
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:review'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ status: 'archived', restorable: true })),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(
      await screen.findByText(/New passes cannot use it\. Existing passes keep working\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask a publisher to restore it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('shows the manifest', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    const editor = await screen.findByRole('textbox', { name: 'Manifest JSON' });
    expect((editor as HTMLTextAreaElement).value).toContain('"inputs"');
  });

  it('keeps the tab in the URL and falls back to overview for unknown tabs', async () => {
    const user = userEvent.setup();
    const handlers = {
      '/api/v1/orgs': orgs,
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1/preview': preview,
    };
    const { router } = await renderApp('/admin/templates/tpl1?tab=bogus', {
      session: 'admin',
      ...orgAccess,
      handlers,
    });
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Inputs' }));
    await waitFor(() =>
      expect((router.state.location.search as { tab?: string }).tab).toBe('inputs'),
    );
  });

  it('saves an edited manifest and shows server errors by path', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
        '/api/v1/templates/tpl1/manifest': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? problem(422, 'MANIFEST_INVALID', 'The manifest is invalid.', [
                { path: '/bindings/0/to', message: 'Unknown target.' },
              ])
            : json(templateDetail());
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    const editor = await screen.findByRole('textbox', { name: 'Manifest JSON' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(editor, { target: { value: '{"draft":true}' } });
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('/bindings/0/to: Unknown target.')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ manifest: { draft: true } });
    // The newest inactive version is the one just saved; the editor keeps the submitted text.
    expect(await screen.findByText('Version 2 saved, inactive')).toBeInTheDocument();
    expect(editor).toHaveValue('{"draft":true}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('rejects malformed JSON before calling the server', async () => {
    const user = userEvent.setup();
    let calls = 0;
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': preview,
        '/api/v1/templates/tpl1/manifest': () => {
          calls += 1;
          return json(templateDetail());
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Manifest' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Manifest JSON' }), {
      target: { value: '{' },
    });
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid JSON');
    expect(calls).toBe(0);
  });

  it('shows an error state for a missing template', async () => {
    await renderApp('/admin/templates/nope', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/nope': () => problem(404, 'not_found', 'Template not found.'),
      },
    });
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    // The page keeps its header: title and the way up.
    expect(screen.getByRole('heading', { level: 1, name: 'Template' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to templates' })).toHaveAttribute(
      'href',
      `/admin/templates?orgId=${ORG.id}`,
    );
  });
});

describe('template upload', () => {
  const previous = importPolling.ms;
  beforeEach(() => {
    importPolling.ms = 15;
  });
  afterEach(() => {
    importPolling.ms = previous;
  });

  it('requires an explicit organization even with a single membership', async () => {
    try {
      localStorage.removeItem('wallet-org-filter');
    } catch {
      // Storage is unavailable in this runtime.
    }
    const { fetchMock } = await renderApp('/admin/templates/upload', {
      session: 'admin',
      memberships: orgAccess.memberships,
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/templates/uploads'))).toBe(
      false,
    );
  });

  it('does not offer uploads to a selected membership without template authoring', async () => {
    const { fetchMock } = await renderApp('/admin/templates/upload?templateId=tpl1', {
      session: 'admin',
      memberships: [membershipFixture(ORG.id, { capabilities: ['templates:read'] })],
      selectedOrg: ORG.id,
      handlers: { '/api/v1/templates/tpl1': () => json(templateDetail()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/templates/tpl1'))).toBe(
      false,
    );
  });

  it('does not mount a version upload or poll its report for a different tenant', async () => {
    let polls = 0;
    await renderApp('/admin/templates/upload?templateId=tpl1&upload=up1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(templateDetail({ orgId: 'org2', orgName: 'Harbor', name: 'Private template' })),
        '/api/v1/templates/uploads/up1': () => {
          polls += 1;
          return problem(404, 'not_found', 'Not found.');
        },
      },
    });
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Private template')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload version' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(polls).toBe(0);
  });

  it('allows a tenant author to read a shared template but not upload a shared version', async () => {
    await renderApp('/admin/templates/upload?templateId=tpl1', {
      session: 'user',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail({ orgId: null, orgName: null })),
      },
    });
    expect(
      await screen.findByText('Only platform administrators can change a shared template.'),
    ).toBeInTheDocument();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload version' })).toBeNull();
  });

  it('unmounts an existing-version form and its file on an organization switch', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload?templateId=tpl1', {
      session: 'admin',
      ...bothOrgs,
      handlers: { '/api/v1/templates/tpl1': () => json(templateDetail()) },
    });
    await screen.findByRole('button', { name: 'Upload version' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'card.zip', { type: 'application/zip' }));
    expect(screen.getByRole('button', { name: 'Upload version' })).toBeEnabled();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Copper card')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('synchronizes the form organization with the authorized scope before uploading', async () => {
    const user = userEvent.setup();
    const posted: URL[] = [];
    const { router } = await renderApp('/admin/templates/upload', {
      session: 'admin',
      memberships: [
        ...bothOrgs.memberships,
        membershipFixture('org3', { orgName: 'Reviewer', capabilities: ['templates:read'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/uploads': (url) => {
          posted.push(url);
          return json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202);
        },
      },
    });
    await screen.findByRole('combobox', { name: 'Organization' });
    let input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'old.zip', { type: 'application/zip' }));
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
    await user.click(screen.getByRole('combobox', { name: 'Organization' }));
    expect(screen.queryByRole('option', { name: 'Reviewer' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'All organizations' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveTextContent('Harbor');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'new.zip', { type: 'application/zip' }));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.searchParams.get('orgId')).toBe('org2');
  });

  it.each([
    { label: 'tenant', orgId: ORG.id, expectedOrg: ORG.id },
    { label: 'shared', orgId: null, expectedOrg: null },
  ])(
    'uploads a $label version to the template’s actual organization',
    async ({ orgId, expectedOrg }) => {
      const user = userEvent.setup();
      const posted: URL[] = [];
      const polled: (string | null)[] = [];
      await renderApp('/admin/templates/upload?templateId=tpl1', {
        session: 'admin',
        ...orgAccess,
        handlers: {
          '/api/v1/templates/tpl1': () => json(templateDetail({ orgId })),
          '/api/v1/templates/uploads': (url) => {
            posted.push(url);
            return json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202);
          },
          '/api/v1/templates/uploads/up1': (url) => {
            polled.push(url.searchParams.get('orgId'));
            return json({
              uploadId: 'up1',
              status: 'queued',
              step: null,
              templateId: null,
              version: null,
              report: null,
              error: null,
            });
          },
        },
      });
      await screen.findByRole('button', { name: 'Upload version' });
      const input = document.querySelector('input[type=file]') as HTMLInputElement;
      await user.upload(input, new File(['zip'], 'card.zip', { type: 'application/zip' }));
      await user.click(screen.getByRole('button', { name: 'Upload version' }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]?.searchParams.get('orgId')).toBe(expectedOrg);
      expect(posted[0]?.searchParams.get('name')).toBe('Copper card');
      await waitFor(() => expect(polled.length).toBeGreaterThan(0));
      expect(polled.every((id) => id === expectedOrg)).toBe(true);
    },
  );

  it('does not allow a version upload when the target template cannot be loaded', async () => {
    await renderApp('/admin/templates/upload?templateId=missing', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/missing': () => problem(404, 'NOT_FOUND', 'Template not found.'),
      },
    });
    expect(await screen.findByText('Could not load the template')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('identifies shared impact before uploading a version', async () => {
    await renderApp('/admin/templates/upload?templateId=tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/tpl1': () => json(templateDetail({ orgId: null, orgName: null })),
      },
    });
    expect(
      await screen.findByText(/Organization: All organizations \(shared\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Template changes are not isolated by the Test view/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload version' })).toBeDisabled();
  });

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    const choice = await screen.findByRole('option', { name: ORG.name });
    expect(screen.queryByRole('option', { name: 'Outside organization' })).not.toBeInTheDocument();
    await user.click(choice);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'card.zip', { type: 'application/zip' }));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
  }

  const complete = {
    uploadId: 'up1',
    status: 'complete',
    step: null,
    templateId: 'tpl7',
    version: 'abc',
    error: null,
    report: {
      ok: true,
      issues: [{ severity: 'warning', code: 'IMG', message: 'Dropped unused slot.' }],
    },
  };

  it('requests reopened status with the selected org and masks a foreign upload', async () => {
    const seen: (string | null)[] = [];
    await renderApp('/admin/templates/upload?upload=up1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/uploads/up1': (url) => {
          seen.push(url.searchParams.get('orgId'));
          return problem(404, 'not_found', 'Not found.');
        },
      },
    });
    expect(await screen.findByText('Could not read the upload')).toBeInTheDocument();
    expect(seen).toEqual([ORG.id]);
    expect(screen.queryByRole('link', { name: 'Open template' })).toBeNull();
    expect(screen.queryByText('Dropped unused slot.')).toBeNull();
  });

  it('stops polling a reopened upload when the selected organization changes', async () => {
    const user = userEvent.setup();
    const seen: (string | null)[] = [];
    await renderApp('/admin/templates/upload?upload=up1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/uploads/up1': (url) => {
          seen.push(url.searchParams.get('orgId'));
          return json({
            uploadId: 'up1',
            status: 'running',
            step: 'analyze',
            templateId: null,
            version: null,
            report: null,
            error: null,
          });
        },
      },
    });
    expect(await screen.findByText('Checking files and images')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(screen.queryByText('Checking files and images')).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === ORG.id)).toBe(true);
  });

  it('does not reveal a completed upload report while its result belongs to another org', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { fetchMock } = await renderApp('/admin/templates/upload?upload=up1', {
      session: 'admin',
      ...bothOrgs,
      handlers: {
        '/api/v1/templates/uploads/up1': () => json(complete),
        '/api/v1/templates/tpl7': () => pending,
      },
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/templates/tpl7'))).toBe(
        true,
      ),
    );
    expect(screen.queryByText('Dropped unused slot.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open template' })).toBeNull();
    await act(async () => {
      resolve(
        json(
          templateDetail({ id: 'tpl7', orgId: 'org2', orgName: 'Harbor', name: 'Private result' }),
        ),
      );
    });
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.queryByText('Private result')).toBeNull();
    expect(screen.queryByText('Dropped unused slot.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open template' })).toBeNull();
  });

  it('uploads, polls the workflow, then opens the new template in its place', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const posted: { url: URL; init?: RequestInit }[] = [];
    const { router } = await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': directoryOrgs,
        '/api/v1/templates/uploads': (url, init) => {
          posted.push({ url, init });
          return json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202);
        },
        '/api/v1/templates/uploads/up1': () => {
          polls += 1;
          const base = { ...complete, templateId: null, version: null, report: null };
          if (polls === 1) return json({ ...base, status: 'queued' });
          if (polls < 4) return json({ ...base, status: 'running', step: 'analyze' });
          return json(complete);
        },
        '/api/v1/templates/tpl7': () => json(templateDetail({ id: 'tpl7', name: 'Card' })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl7/preview': preview,
      },
    });
    const entries = router.history.length;
    await fill(user);
    expect(await screen.findByText('Checking files and images')).toBeInTheDocument();
    // Done: the template's page replaces the upload and says what happened.
    expect(await screen.findByText('Template imported')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/templates/tpl7');
    expect(router.history.length).toBe(entries);
    expect(screen.getByRole('heading', { level: 1, name: 'Card' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload another' })).toHaveAttribute(
      'href',
      '/admin/templates/upload?orgId=org1',
    );
    expect(posted[0]?.url.searchParams.get('orgId')).toBe('org1');
    const headers = (posted[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/zip');
    // Polling stops at the final state.
    const settled = polls;
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBe(settled);
  });

  it('keeps a finished report reopened from Recent uploads on the page', async () => {
    await renderApp('/admin/templates/upload?upload=up1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads/up1': () => json(complete),
        '/api/v1/templates/tpl7': () => json(templateDetail({ id: 'tpl7', versions: [] })),
      },
    });
    expect(await screen.findByText('New template')).toBeInTheDocument();
    // One buddy: it leaves the drop zone for the done card.
    expect(document.querySelectorAll('[data-buddy]')).toHaveLength(1);
    expect(document.querySelector('.wl-drop [data-buddy]')).toBeNull();
    expect(screen.getByText('Dropped unused slot.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open template' })).toHaveAttribute(
      'href',
      '/admin/templates/tpl7?orgId=org1',
    );
  });

  it.each([403, 404])(
    'does not expose a completed report when its template returns %s',
    async (status) => {
      await renderApp('/admin/templates/upload?upload=up1', {
        session: 'admin',
        ...orgAccess,
        handlers: {
          '/api/v1/templates/uploads/up1': () => json(complete),
          '/api/v1/templates/tpl7': () => problem(status, 'not_found', 'Not found.'),
        },
      });
      expect(await screen.findByText('Template not found')).toBeInTheDocument();
      expect(screen.queryByText('Dropped unused slot.')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open template' })).toBeNull();
    },
  );

  it('shows the failure and takes a fixed file without asking again', async () => {
    const user = userEvent.setup();
    const posts: URL[] = [];
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': (url) => {
          posts.push(url);
          return json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202);
        },
        '/api/v1/templates/uploads/up1': () =>
          json({
            uploadId: 'up1',
            status: 'errored',
            step: 'unzip',
            templateId: null,
            version: null,
            error: 'Archive has too many entries.',
            report: {
              ok: false,
              issues: [{ severity: 'error', code: 'ZIP_LIMIT', message: 'More than 100 entries.' }],
            },
          }),
      },
    });
    await fill(user);
    expect(await screen.findByText('Archive has too many entries.')).toBeInTheDocument();
    expect(screen.getByText('More than 100 entries.')).toBeInTheDocument();
    // The fix goes straight up with the same org.
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['zip'], 'fixed.zip', { type: 'application/zip' }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]?.searchParams.get('orgId')).toBe('org1');
  });

  it('maps the IMPORT_INVALID code to a sentence', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': () =>
          json({ uploadId: 'up1', workflowInstanceId: 'wf1' }, 202),
        '/api/v1/templates/uploads/up1': () =>
          json({
            uploadId: 'up1',
            status: 'errored',
            step: 'validate',
            templateId: null,
            version: null,
            error: 'IMPORT_INVALID',
            report: { ok: false, issues: [] },
          }),
      },
    });
    await fill(user);
    expect(
      await screen.findByText('The package has errors. Fix them and upload again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('IMPORT_INVALID')).toBeNull();
  });

  it('shows the server error when the upload is rejected', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/templates/uploads': () => problem(413, 'TOO_LARGE', 'File is over 15 MB.'),
      },
    });
    await fill(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('File is over 15 MB.');
    // Refused outright: the drop zone shakes and its header piece slides out.
    expect(document.querySelector('.wl-drop')).toHaveAttribute('data-rejected');
  });

  it('rejects other file types before upload and keeps Upload disabled', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: { '/api/v1/orgs': orgs },
    });
    await screen.findByRole('combobox', { name: 'Organization' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText('Choose a .zip or .pkpasstemplate.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(document.querySelector('.wl-drop')).toHaveAttribute('data-rejected');
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/templates/upload', {
      session: 'admin',
      ...orgAccess,
      handlers: { '/api/v1/orgs': orgs },
    });
    await screen.findByRole('combobox', { name: 'Organization' });
    expect((await axe(container)).violations).toEqual([]);
  });
});
