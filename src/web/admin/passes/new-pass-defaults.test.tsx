import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '../../lib/mode.ts';
import {
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '../../lib/test-utils.tsx';
import {
  eligibleTemplate,
  INPUT_SCHEMA,
  ORG,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateVersionDetail,
} from './test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const henry = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });

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
  vi.unstubAllGlobals();
});

describe('new pass organization selection', () => {
  it('requires an explicit operable membership and scopes both lists', async () => {
    const user = userEvent.setup();
    const passRequests: URL[] = [];
    const templateRequests: URL[] = [];
    const { router } = await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': (url) => {
          passRequests.push(url);
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates/eligible': (url) => {
          templateRequests.push(url);
          return json({ items: [eligibleTemplate()], nextCursor: null });
        },
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    const henryChoice = await screen.findByRole('radio', { name: /Henry's/ });
    expect(henryChoice).not.toBeChecked();
    expect(passRequests).toHaveLength(0);
    expect(templateRequests).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Choose an organization.')).toBeInTheDocument();

    await user.click(henryChoice);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: ORG.id }));
    await waitFor(() => expect(passRequests.length).toBeGreaterThan(0));
    await waitFor(() => expect(templateRequests.length).toBeGreaterThan(0));
    expect(passRequests.every((url) => url.searchParams.get('orgId') === ORG.id)).toBe(true);
    expect(passRequests.every((url) => url.searchParams.get('limit') === '1')).toBe(true);
    expect(
      templateRequests.every(
        (url) =>
          url.searchParams.get('orgId') === ORG.id &&
          url.searchParams.get('mode') === 'live' &&
          url.searchParams.get('provider') === 'apple',
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
  });

  it('offers only organizations where passes can be issued', async () => {
    await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [
        henry,
        membershipFixture('readonly', {
          orgName: 'Read only',
          capabilities: ['org:read', 'passes:read'],
        }),
      ],
    });
    expect(await screen.findByRole('radio', { name: /Henry's/ })).not.toBeChecked();
    expect(screen.queryByRole('radio', { name: /Read only/ })).toBeNull();
  });

  it('rejects an unauthorized organization and template in the URL without resource requests', async () => {
    const passRequests: URL[] = [];
    const templateRequests: URL[] = [];
    let detailRequests = 0;
    await renderApp('/admin/passes/new?orgId=outsider&templateId=tpl1', {
      session: 'admin',
      memberships: [
        henry,
        membershipFixture('readonly', {
          orgName: 'Read only',
          capabilities: ['org:read', 'passes:read'],
        }),
      ],
      handlers: {
        '/api/v1/passes': (url) => {
          passRequests.push(url);
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates/eligible': (url) => {
          templateRequests.push(url);
          return json({ items: [eligibleTemplate()], nextCursor: null });
        },
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => {
          detailRequests += 1;
          return json(templateVersionDetail());
        },
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Henry's/ })).toBeNull();
    expect(passRequests).toHaveLength(0);
    expect(templateRequests).toHaveLength(0);
    expect(detailRequests).toBe(0);
  });

  it('starts at templates for an explicitly selected authorized scope', async () => {
    const passRequests: URL[] = [];
    await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [henry],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/passes': (url) => {
          passRequests.push(url);
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(await screen.findByRole('radio', { name: /Copper card/ })).not.toBeChecked();
    await waitFor(() => expect(passRequests.length).toBeGreaterThan(0));
    expect(
      passRequests.every(
        (url) => url.searchParams.get('orgId') === ORG.id && url.searchParams.get('limit') === '1',
      ),
    ).toBe(true);
  });

  it('scopes the selected release, version, and preview for a non-platform member', async () => {
    const user = userEvent.setup();
    const batchRequests: URL[] = [];
    const eligibleRequests: URL[] = [];
    const versionRequests: URL[] = [];
    const draftRequests: Record<string, unknown>[] = [];
    await renderApp('/admin/passes/new', {
      session: 'user',
      memberships: [henry],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': (url) => {
          eligibleRequests.push(url);
          return json({ items: [eligibleTemplate()], nextCursor: null });
        },
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': (url) => {
          versionRequests.push(url);
          return json(templateVersionDetail());
        },
        '/api/v1/templates/previews': (url) => {
          batchRequests.push(url);
          return previewsHandler(url);
        },
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          draftRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
      },
    });
    const tile = await screen.findByRole('radio', { name: /Copper card/ });
    expect(batchRequests).toHaveLength(0);
    await user.click(tile);
    await waitFor(() => expect(eligibleRequests.length).toBeGreaterThan(0));
    expect(
      eligibleRequests.every(
        (url) =>
          url.searchParams.get('orgId') === ORG.id &&
          url.searchParams.get('mode') === 'live' &&
          url.searchParams.get('provider') === 'apple',
      ),
    ).toBe(true);
    await waitFor(() => expect(versionRequests.length).toBeGreaterThan(0));
    expect(versionRequests.every((url) => url.searchParams.get('orgId') === ORG.id)).toBe(true);
    await waitFor(() => expect(draftRequests.length).toBeGreaterThan(0));
    expect(
      draftRequests.every((body) => body.orgId === ORG.id && body.version === 'a1b2c3d4e5f6a7b8'),
    ).toBe(true);
    expect(batchRequests).toHaveLength(0);
  });

  it('explains missing template-read permission instead of loading indefinitely', async () => {
    const templateRequests: URL[] = [];
    await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [{ ...henry, capabilities: ['org:read', 'passes:read', 'passes:operate'] }],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': (url) => {
          templateRequests.push(url);
          return json({ items: [], nextCursor: null });
        },
      },
    });
    expect(
      await screen.findByText('You need permission to view templates for this organization.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(templateRequests).toHaveLength(0);
  });

  it.each([
    ['a foreign template', { templateOrgId: 'org2' }],
    ['a release without a candidate hash', { candidateHash: '' }],
    ['a release without a version', { version: '' }],
  ])('does not accept %s as an eligible selection', async (_label, overrides) => {
    let versionRequests = 0;
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'user',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': () =>
          json({ items: [eligibleTemplate(overrides)], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => {
          versionRequests += 1;
          return json(templateVersionDetail());
        },
      },
    });
    expect(await screen.findByText(/No active approved Apple Wallet release/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
    expect(versionRequests).toBe(0);
  });

  it('rejects an eligible release with a null version without creating a pass', async () => {
    let posts = 0;
    const { queryClient } = await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'user',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': (_url, init) => {
          if (method(init) === 'POST') posts += 1;
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates/eligible': () =>
          json({ items: [eligibleTemplate({ version: null })], nextCursor: null }),
      },
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', 'org1', 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('error'),
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
    expect(posts).toBe(0);
  });

  it.each(['baked', 'uploaded'] as const)(
    'issues a server-eligible global %s template for the selected organization',
    async (origin) => {
      const user = userEvent.setup();
      const posts: Record<string, unknown>[] = [];
      await renderApp('/admin/passes/new', {
        session: 'user',
        memberships: [henry],
        selectedOrg: ORG.id,
        handlers: {
          '/api/v1/passes': (_url, init) => {
            if (method(init) === 'POST') {
              posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              return problem(500, 'failure', 'Try again');
            }
            return json({ items: [], nextCursor: null });
          },
          '/api/v1/templates/eligible': () =>
            json({
              items: [
                eligibleTemplate({
                  templateOrgId: null,
                  origin,
                  releaseId: 'shared-release',
                  releaseGeneration: 3,
                }),
              ],
              nextCursor: null,
            }),
          '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
          '/api/v1/templates/tpl1/preview': () =>
            json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        },
      });
      const tile = await screen.findByRole('radio', { name: /Copper card/ });
      expect(tile.closest('fieldset')).toHaveAccessibleName('Shared');
      await user.click(tile);
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.type(await screen.findByLabelText(/Member name/), 'Sam');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.queryByText('Release generation')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Create pass' }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toMatchObject({
        orgId: 'org1',
        templateId: 'tpl1',
        releaseId: 'shared-release',
        releaseGeneration: 3,
        templateVersion: 'a1b2c3d4e5f6a7b8',
        input: { name: 'Sam' },
      });
    },
  );

  it('rejects an eligible item owned by a different organization', async () => {
    let draftPreviews = 0;
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': () =>
          json({ items: [eligibleTemplate({ templateOrgId: 'outsider' })], nextCursor: null }),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': () => {
          draftPreviews += 1;
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
      },
    });
    expect(await screen.findByText(/No active approved Apple Wallet release/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
    expect(draftPreviews).toBe(0);
  });
});

describe('new pass details step', () => {
  it('seeds schema defaults and skips previews while the input is invalid', async () => {
    const user = userEvent.setup();
    const previewPosts: unknown[] = [];
    const schema = {
      ...INPUT_SCHEMA,
      properties: {
        ...INPUT_SCHEMA.properties,
        level: { ...INPUT_SCHEMA.properties.level, default: 'blue' },
      },
    };
    const { router, queryClient } = await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
          json(templateVersionDetail({ manifest: { inputs: schema, sample: { name: 'Sam' } } })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': (_u, init) => {
          if (method(init) === 'POST') {
            const body = JSON.parse(String(init?.body)) as { input?: unknown };
            if (body.input) previewPosts.push(body);
          }
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Henry's/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: ORG.id }));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', ORG.id, 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);

    expect(screen.getByRole('combobox', { name: /Level/ })).toHaveTextContent('Blue');
    await user.click(screen.getByRole('combobox', { name: /Level/ }));
    expect(screen.queryByRole('option', { name: 'None' })).toBeNull();
    await user.keyboard('{Escape}');

    // The card shows from the first frame: empty required fields borrow the sample.
    await waitFor(() =>
      expect(previewPosts).toContainEqual({
        input: { name: 'Sam', level: 'blue' },
        orgId: 'org1',
        version: 'a1b2c3d4e5f6a7b8',
      }),
    );
    await user.type(screen.getByLabelText(/Member name/), 'Ann');
    await waitFor(() =>
      expect(previewPosts).toContainEqual({
        input: { name: 'Ann', level: 'blue' },
        orgId: 'org1',
        version: 'a1b2c3d4e5f6a7b8',
      }),
    );
  });

  it('uses the released version fields and preview when the template draft differs', async () => {
    const previewBodies: Record<string, unknown>[] = [];
    const releasedSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', 'x-label': 'Released name' } },
    };
    const legacyRequests: string[] = [];
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'user',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1': () => {
          legacyRequests.push('detail');
          return json(
            templateDetail({
              activeVersion: 'ffeeddccbbaa9988',
              inputSchema: {
                type: 'object',
                properties: { draft: { type: 'string', 'x-label': 'Draft only' } },
              },
            }),
          );
        },
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
          json(
            templateVersionDetail({
              manifest: { inputs: releasedSchema, sample: { name: 'Sam' } },
            }),
          ),
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          previewBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
      },
    });
    expect(await screen.findByLabelText(/Released name/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Draft only')).toBeNull();
    await waitFor(() => expect(previewBodies.length).toBeGreaterThan(0));
    expect(previewBodies.every((body) => body.version === 'a1b2c3d4e5f6a7b8')).toBe(true);
    expect(legacyRequests).toEqual([]);
  });

  it('issues a released template with a valid empty input schema', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/passes': (_url, init) => {
          if (method(init) === 'POST') {
            posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return json({}, 500);
          }
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
          json(
            templateVersionDetail({
              manifest: { inputs: { type: 'object', properties: {} }, sample: {} },
            }),
          ),
        '/api/v1/templates/tpl1/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
      },
    });
    expect(await screen.findByText('This template has no inputs.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create pass' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ input: {}, releaseId: 'release1', releaseGeneration: 1 });
  });

  it('does not use a version response for a different version', async () => {
    let previews = 0;
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
          json(templateVersionDetail({ version: 'ffeeddccbbaa9988' })),
        '/api/v1/templates/tpl1/preview': () => {
          previews += 1;
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(
      await screen.findByText(/returned a different version than the approved release/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(previews).toBe(0);
  });

  it('shows and retries a released-version error', async () => {
    const user = userEvent.setup();
    let reads = 0;
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () =>
          ++reads === 1
            ? problem(400, 'down', 'Released version unavailable')
            : json(templateVersionDetail()),
        '/api/v1/templates/tpl1/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Released version unavailable');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/Member name/)).toBeInTheDocument();
  });

  it('shows a retryable preview failure instead of an indefinite skeleton', async () => {
    const user = userEvent.setup();
    let previews = 0;
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () => json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/templates/tpl1/preview': () =>
          ++previews === 1
            ? problem(400, 'bad_preview', 'Preview unavailable')
            : json({
                passJson: SAMPLE_PASS_JSON,
                warnings: [],
                assetBaseUrl: '/a',
                assetNames: [],
              }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Show pass' })).toBeInTheDocument();
  });
});

describe('new pass template step', () => {
  async function openTemplates(items: unknown[]) {
    const user = userEvent.setup();
    const previewOk = () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] });
    const { router, queryClient } = await renderApp('/admin/passes/new', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () => json({ items, nextCursor: null }),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': previewOk,
        '/api/v1/templates/tpl2/preview': previewOk,
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Henry's/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: ORG.id }));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'eligible', ORG.id, 'live', 'apple', 'u1'])
          ?.status,
      ).toBe('success'),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    return user;
  }

  it('files templates every org can use under Shared', async () => {
    await openTemplates([
      eligibleTemplate({ templateId: 'tpl2', name: 'Plain card', templateOrgId: null }),
      eligibleTemplate(),
    ]);
    const plain = await screen.findByRole('radio', { name: /Plain card/ });
    expect(plain.closest('fieldset')).toHaveAccessibleName('Shared');
    expect(plain.closest('label')).not.toHaveTextContent('Shared');
    expect(
      screen.getByRole('radio', { name: /Copper card/ }).closest('fieldset'),
    ).toHaveAccessibleName("Henry's");
  });

  it('does not offer a template omitted from the eligible list', async () => {
    await openTemplates([eligibleTemplate()]);
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Unpublished card/ })).toBeNull();
  });

  it('advances on Enter from a focused template', async () => {
    const user = await openTemplates([eligibleTemplate()]);
    const tile = await screen.findByRole('radio', { name: /Copper card/ });
    tile.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Details' })).toBeInTheDocument();
  });

  it('pages eligible releases and issues exactly the selected later-page release', async () => {
    const user = userEvent.setup();
    const requests: URL[] = [];
    const previews: Record<string, unknown>[] = [];
    const posts: Record<string, unknown>[] = [];
    await renderApp('/admin/passes/new?orgId=org1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': (url) => {
          requests.push(url);
          return url.searchParams.get('cursor')
            ? json({
                items: [
                  eligibleTemplate({
                    templateId: 'tpl2',
                    name: 'Silver card',
                    releaseId: 'release2',
                    releaseGeneration: 7,
                    version: 'ffeeddccbbaa9988',
                  }),
                ],
                nextCursor: null,
              })
            : json({ items: [eligibleTemplate()], nextCursor: 'next-page' });
        },
        '/api/v1/templates/tpl2/versions/ffeeddccbbaa9988': () =>
          json(templateVersionDetail({ version: 'ffeeddccbbaa9988' })),
        '/api/v1/templates/tpl2/preview': (_url, init) => {
          previews.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/passes': (_url, init) => {
          if (method(init) === 'POST') {
            posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return problem(500, 'failure', 'Try again');
          }
          return json({ items: [], nextCursor: null });
        },
      },
    });
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await user.click(await screen.findByRole('radio', { name: /Silver card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText(/Member name/), 'Alex');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('ffeeddccbbaa9988')).toBeInTheDocument();
    expect(screen.queryByText('Release generation')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create pass' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      orgId: 'org1',
      mode: 'live',
      templateId: 'tpl2',
      templateVersion: 'ffeeddccbbaa9988',
      releaseId: 'release2',
      releaseGeneration: 7,
      input: { name: 'Alex' },
    });
    expect(requests.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'next-page']);
    expect(
      requests.every(
        (url) =>
          url.searchParams.get('orgId') === 'org1' &&
          url.searchParams.get('mode') === 'live' &&
          url.searchParams.get('provider') === 'apple' &&
          url.searchParams.get('limit') === '200',
      ),
    ).toBe(true);
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    expect(
      previews.every((body) => body.orgId === 'org1' && body.version === 'ffeeddccbbaa9988'),
    ).toBe(true);
  });

  it('finds a deep-linked eligible template beyond the first page', async () => {
    const cursors: (string | null)[] = [];
    await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': (url) => {
          const cursor = url.searchParams.get('cursor');
          cursors.push(cursor);
          return cursor
            ? json({ items: [eligibleTemplate()], nextCursor: null })
            : json({ items: [], nextCursor: 'next-page' });
        },
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/templates/tpl1/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByLabelText(/Member name/)).toBeInTheDocument();
    expect(cursors).toEqual([null, 'next-page']);
  });

  it('opens a changed template deep link instead of retaining the previous draft', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () =>
          json({
            items: [
              eligibleTemplate(),
              eligibleTemplate({ templateId: 'tpl2', name: 'Silver card', releaseId: 'release2' }),
            ],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/templates/tpl2/versions/a1b2c3d4e5f6a7b8': () =>
          json(
            templateVersionDetail({
              manifest: {
                inputs: {
                  type: 'object',
                  properties: { guest: { type: 'string', 'x-label': 'Guest name' } },
                },
                sample: {},
              },
            }),
          ),
        '/api/v1/templates/tpl1/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        '/api/v1/templates/tpl2/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.type(await screen.findByLabelText(/Member name/), 'Ann');
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org1', templateId: 'tpl2' },
        ignoreBlocker: true,
      });
    });
    expect(await screen.findByLabelText(/Guest name/)).toHaveValue('');
    expect(screen.queryByLabelText(/Member name/)).toBeNull();
  });

  it('shows a retryable eligible-list error instead of an empty list', async () => {
    const user = userEvent.setup();
    let reads = 0;
    await renderApp('/admin/passes/new?orgId=org1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': () =>
          ++reads === 1
            ? problem(400, 'down', 'Eligible templates unavailable')
            : json({ items: [eligibleTemplate()], nextCursor: null }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Eligible templates unavailable');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
  });

  it('keeps loaded choices and retries a failed next page', async () => {
    const user = userEvent.setup();
    let nextPageReads = 0;
    await renderApp('/admin/passes/new?orgId=org1', {
      session: 'admin',
      memberships: [henry],
      handlers: {
        '/api/v1/templates/eligible': (url) => {
          if (!url.searchParams.get('cursor'))
            return json({ items: [eligibleTemplate()], nextCursor: 'next-page' });
          return ++nextPageReads === 1
            ? problem(400, 'down', 'Page unavailable')
            : json({
                items: [
                  eligibleTemplate({
                    templateId: 'tpl2',
                    name: 'Silver card',
                    releaseId: 'release2',
                  }),
                ],
                nextCursor: null,
              });
        },
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/templates/tpl1/preview': () =>
          json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] }),
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/Could not load more/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Copper card/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /Silver card/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Copper card/ })).toBeChecked();
  });

  it('does not carry an old organization’s preview or debounced inputs into the next one', async () => {
    const user = userEvent.setup();
    // Promise.withResolvers is unavailable in the ES2023 web test target.
    let resolveOld!: (response: Response) => void;
    const oldPreview = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const previews: Record<string, unknown>[] = [];
    let oldRequests = 0;
    const other = membershipFixture('org2', { orgName: 'Other', orgSlug: 'other' });
    const { router } = await renderApp('/admin/passes/new?orgId=org1&templateId=tpl1', {
      session: 'admin',
      memberships: [henry, other],
      handlers: {
        '/api/v1/templates/eligible': (url) =>
          json({
            items: [eligibleTemplate({ templateOrgId: url.searchParams.get('orgId') })],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl1/versions/a1b2c3d4e5f6a7b8': () => json(templateVersionDetail()),
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          previews.push(body);
          if (body.orgId === 'org1') {
            oldRequests += 1;
            return oldPreview;
          }
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    await screen.findByLabelText(/Member name/);
    await waitFor(() => expect(oldRequests).toBeGreaterThan(0));
    await user.type(screen.getByLabelText(/Member name/), 'Ann');
    await act(async () => {
      await router.navigate({
        to: '/admin/passes/new',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText(/Member name/)).toHaveValue('');
    await user.type(screen.getByLabelText(/Member name/), 'Beth');
    await waitFor(() =>
      expect(
        previews.some(
          (body) =>
            body.orgId === 'org2' &&
            (body.input as Record<string, unknown> | undefined)?.name === 'Beth',
        ),
      ).toBe(true),
    );
    await act(async () =>
      resolveOld(
        json({
          passJson: SAMPLE_PASS_JSON,
          warnings: [{ severity: 'warning', code: 'OLD_SCOPE', message: 'Old scope warning' }],
          assetBaseUrl: '/a',
          assetNames: [],
        }),
      ),
    );
    expect(
      previews
        .filter((body) => body.orgId === 'org2')
        .every((body) => (body.input as Record<string, unknown> | undefined)?.name !== 'Ann'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByText('Old scope warning')).toBeNull();
  });

  it.each(['organization', 'mode', 'principal'] as const)(
    'ignores a deferred eligible response after changing %s',
    async (changed) => {
      // Promise.withResolvers is unavailable in the ES2023 web test target.
      let resolveOld!: (response: Response) => void;
      const oldResponse = new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
      const other = membershipFixture('org2', { orgName: 'Other', orgSlug: 'other' });
      let principal = 'u1';
      let oldRequests = 0;
      const { router, queryClient } = await renderApp('/admin/passes/new?orgId=org1', {
        session: 'admin',
        memberships: [henry, other],
        handlers: {
          '/api/v1/templates/eligible': (url) => {
            const old =
              url.searchParams.get('orgId') === 'org1' &&
              url.searchParams.get('mode') === 'live' &&
              principal === 'u1';
            if (old) {
              oldRequests += 1;
              return oldResponse;
            }
            return json({
              items: [
                eligibleTemplate({
                  templateId: 'tplB',
                  name: 'Current card',
                  templateOrgId: changed === 'organization' ? 'org2' : 'org1',
                }),
              ],
              nextCursor: null,
            });
          },
          '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        },
      });
      await waitFor(() => expect(oldRequests).toBeGreaterThan(0));
      await act(async () => {
        if (changed === 'organization') {
          await router.navigate({ to: '/admin/passes/new', search: { orgId: 'org2' } });
        } else if (changed === 'mode') {
          setMode('test');
        } else {
          principal = 'u2';
          const replacement = sessionFixture('admin');
          if (!replacement.authenticated) throw new Error('Expected an authenticated fixture');
          queryClient.setQueryData(['org-memberships', 'me'], {
            items: [
              { ...henry, userId: 'u2' },
              { ...other, userId: 'u2' },
            ],
          });
          queryClient.setQueryData(['session'], {
            ...replacement,
            user: { ...replacement.user, id: 'u2' },
          });
        }
      });
      expect(await screen.findByRole('radio', { name: /Current card/ })).toBeInTheDocument();
      await act(async () =>
        resolveOld(
          json({
            items: [eligibleTemplate({ name: 'Old card' })],
            nextCursor: null,
          }),
        ),
      );
      expect(screen.queryByRole('radio', { name: /Old card/ })).toBeNull();
      expect(screen.getByRole('radio', { name: /Current card/ })).not.toBeChecked();
    },
  );
});
