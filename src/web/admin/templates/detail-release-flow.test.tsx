import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setCsrfProvider } from '../../lib/api.ts';
import { resetModeForTests } from '../../lib/mode.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail } from '../passes/test-fixtures.ts';

beforeEach(() => setCsrfProvider(async () => 'csrf'));
afterEach(() => {
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

const member = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const LIVE = 'a1b2c3d4e5f6a7b8';
const DRAFT = 'ffeeddccbbaa9988';
const state = (over: Record<string, unknown> = {}) => ({
  live: { version: LIVE, at: 1_700_000_000_000, by: 'Alex Kim' },
  test: { version: LIVE, at: 1_700_000_000_000, state: 'following' },
  draft: { version: DRAFT, at: 1_700_000_100_000 },
  review: { state: 'none' },
  alone: true,
  next: 'release',
  ...over,
});
const detail = (release: unknown) => {
  const d = templateDetail({ release });
  d.versions[1] = { ...d.versions[1], report: { ok: true, issues: [] } } as (typeof d.versions)[1];
  return d;
};

it('makes the state’s next step the primary, with the strip showing both modes', async () => {
  await renderApp('/admin/templates/tpl1', {
    session: 'admin',
    memberships: [member],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(detail(state())),
      '/api/v1/templates/previews': previewsHandler,
    },
  });
  expect(await screen.findByRole('button', { name: 'Release v2' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
  const strip = screen.getByRole('region', { name: 'Release' });
  expect(strip).toHaveTextContent('Testv1Same as Live');
  expect(strip).toHaveTextContent('Livev1');
});

it('releases from the dialog: dry run first, then one call with a key', async () => {
  const user = userEvent.setup();
  const posts: { url: URL; body: Record<string, unknown>; key: string | null }[] = [];
  const mode = (outcome: string) => ({
    outcome,
    from: LIVE,
    expectedGeneration: 1,
    candidate: { action: 'create', id: null },
    approval: { action: 'write', kind: 'sole' },
    impact: { passes: { count: 12, capped: false }, devices: { count: 9, capped: false } },
  });
  await renderApp('/admin/templates/tpl1', {
    session: 'admin',
    memberships: [member],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(detail(state())),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1/release': (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posts.push({ url, body, key: new Headers(init?.headers).get('idempotency-key') });
        if (url.searchParams.get('dryRun') === 'true')
          return json({
            version: DRAFT,
            modes: { test: mode('release'), live: mode('release') },
            diff: [
              {
                group: 'colors',
                rows: [
                  {
                    label: 'Background',
                    kind: 'changed',
                    from: { type: 'color', color: '#0F766E' },
                    to: { type: 'color', color: '#4338CA' },
                  },
                ],
                more: 0,
              },
            ],
            fromVersion: LIVE,
            state: state(),
          });
        const done = { outcome: 'released', releaseId: 'r1', generation: 2, approvalKind: 'sole' };
        return json({
          version: DRAFT,
          modes: { test: done, live: done },
          state: state({ next: null }),
        });
      },
    },
  });
  await user.click(await screen.findByRole('button', { name: 'Release v2' }));
  const dialog = await screen.findByRole('dialog', { name: 'Release v2' });
  expect(await within(dialog).findByText('#4338CA')).toBeInTheDocument();
  expect(within(dialog).getByRole('region', { name: 'Colours' })).toHaveTextContent('Background');
  expect(dialog).toHaveTextContent('12 passes update');
  expect(dialog).toHaveTextContent('9 on phones');
  await user.click(within(dialog).getByRole('button', { name: 'Release' }));
  await waitFor(() =>
    expect(posts.some((p) => p.url.searchParams.get('dryRun') !== 'true')).toBe(true),
  );
  const call = posts.find((p) => p.url.searchParams.get('dryRun') !== 'true');
  expect(call?.body).toEqual({ orgId: ORG.id, version: DRAFT, modes: ['test', 'live'] });
  expect(call?.key).toBeTruthy();
});

it('hides the release primary from a viewer with nothing to do', async () => {
  await renderApp('/admin/templates/tpl1', {
    session: 'admin',
    memberships: [
      membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:review'] }),
    ],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(detail(state({ next: null, alone: false }))),
      '/api/v1/templates/previews': previewsHandler,
    },
  });
  await screen.findByRole('heading', { name: 'Copper card' });
  expect(screen.queryByRole('button', { name: /^Release/ })).toBeNull();
});

it('previews the draft, with a Live and Draft toggle once a newer draft exists', async () => {
  const user = userEvent.setup();
  const requested: unknown[] = [];
  await renderApp('/admin/templates/tpl1', {
    session: 'admin',
    memberships: [member],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(detail(state())),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1/preview': (_url, init) => {
        requested.push(JSON.parse(String(init?.body ?? '{}')));
        return json({ passJson: {}, assetBaseUrl: '/a', assetNames: [] });
      },
    },
  });
  const draft = await screen.findByRole('radio', { name: 'Draft' });
  expect(draft).toBeChecked();
  await waitFor(() =>
    expect(requested).toContainEqual(expect.objectContaining({ version: DRAFT })),
  );
  await user.click(screen.getByRole('radio', { name: 'Live' }));
  expect(screen.getByRole('radio', { name: 'Live' })).toBeChecked();
});
