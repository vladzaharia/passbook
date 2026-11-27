import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, problem, renderApp } from '../../lib/test-utils.tsx';
import {
  eligibleTemplate,
  ORG,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';
import { sampleDoc } from '../templates/designer/fixtures.ts';

const ID = 'baked:starter-store-card';
const member = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const access = { memberships: [member], selectedOrg: ORG.id };
const preview = () =>
  json({
    passJson: {
      ...SAMPLE_PASS_JSON,
      backgroundColor: 'rgb(0,75,65)',
      labelColor: 'rgb(242,208,125)',
    },
    warnings: [],
    assetBaseUrl: '/a',
    assetNames: [],
  });
const blueprint = (over: Record<string, unknown> = {}) =>
  templateSummary({
    id: ID,
    orgId: null,
    orgName: null,
    name: 'Balance card',
    description: 'A big balance up front, on a coin strip.',
    origin: 'baked',
    blueprint: true,
    icon: 'coins',
    styles: ['storeCard'],
    passCount: 0,
    ...over,
  });
/** The link's path and its own query, without the retained organization. */
const target = (el: HTMLElement) => {
  const url = new URL(el.getAttribute('href') ?? '', 'https://wallet.test');
  url.searchParams.delete('orgId');
  return decodeURIComponent(`${url.pathname}${url.search}`);
};
const blueprintDetail = (over: Record<string, unknown> = {}) =>
  templateDetail({ ...blueprint(), ...over });
const made = templateDetail({
  id: 'made1',
  name: 'Gym balance',
  activeVersion: null,
  fromBlueprint: { id: ID, name: 'Balance card' },
});
const phone = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 639.98px') || query.includes('max-width: 767.98px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

afterEach(() => {
  clearPreviewBatches();
  vi.unstubAllGlobals();
});

const detailHandlers = (over: Record<string, unknown> = {}) => ({
  [`/api/v1/templates/${ID}`]: () => json(blueprintDetail(over)),
  [`/api/v1/templates/${ID}/preview`]: preview,
  '/api/v1/templates/previews': previewsHandler,
});

describe('Blueprints', () => {
  it('lists blueprints by group, each with Use', async () => {
    const seen: URL[] = [];
    const { container } = await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: {
        '/api/v1/templates': (url) => {
          seen.push(url);
          return json({
            items: [
              blueprint({ group: 'save-spend' }),
              blueprint({
                id: 'baked:starter-generic',
                name: 'Membership',
                icon: 'id-card',
                styles: ['generic'],
                group: 'membership-id',
              }),
            ],
            nextCursor: null,
          });
        },
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('list', { name: 'Save and spend' });
    const names = screen
      .getAllByRole('link', { name: /^(Balance card|Membership)$/ })
      .map((l) => l.textContent);
    expect(names).toEqual(['Balance card', 'Membership']);
    expect(target(screen.getByRole('link', { name: 'Balance card' }))).toBe(
      `/admin/blueprints/${ID}`,
    );
    expect(seen[0]?.searchParams.get('blueprint')).toBe('true');
    expect(screen.getByRole('button', { name: 'Use Balance card' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows the glyph, Blueprint badge, Use blueprint and the passes from before blueprints', async () => {
    await renderApp(`/admin/blueprints/${ID}`, {
      session: 'admin',
      ...access,
      handlers: detailHandlers({ passCount: 2 }),
    });
    expect(await screen.findByRole('heading', { name: 'Balance card' })).toBeInTheDocument();
    expect(screen.getByText('Blueprint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use blueprint' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
    expect(screen.getByText('2 passes from before blueprints')).toBeInTheDocument();
    expect(target(screen.getByRole('link', { name: 'View passes' }))).toBe(
      `/admin/passes?templateId=${ID}`,
    );
  });

  it('sends a blueprint reached by a template link to its own page', async () => {
    const { router } = await renderApp(`/admin/templates/${ID}`, {
      session: 'admin',
      ...access,
      handlers: detailHandlers(),
    });
    expect(await screen.findByRole('button', { name: 'Use blueprint' })).toBeInTheDocument();
    expect(decodeURIComponent(router.state.location.pathname)).toBe(
      `/admin/o/${ORG.id}/blueprints/${ID}`,
    );
  });
});

describe('Use blueprint', () => {
  async function open(user: ReturnType<typeof userEvent.setup>, handlers = {}) {
    const rendered = await renderApp(`/admin/blueprints/${ID}`, {
      session: 'admin',
      ...access,
      handlers: { ...detailHandlers({ activeVersion: 'v1' }), ...handlers },
    });
    await user.click(await screen.findByRole('button', { name: 'Use blueprint' }));
    await screen.findByRole('heading', { name: 'Make it yours', level: 1 });
    return { ...rendered, dialog: document.body };
  }

  it('asks for a name before Open designer', async () => {
    const user = userEvent.setup();
    const { dialog } = await open(user);
    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    expect(name).toHaveValue('Balance card');
    await user.clear(name);
    await user.click(within(dialog).getByRole('button', { name: 'Open designer' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
  });

  it('opens the designer on a draft; Create template makes the template without the flag', async () => {
    const user = userEvent.setup();
    const doc = sampleDoc();
    const checks: unknown[] = [];
    const bodies: {
      orgId: string;
      name: string;
      version: { manifest: Record<string, unknown> };
    }[] = [];
    const { router, dialog } = await open(user, {
      [`/api/v1/templates/${ID}/versions/v1`]: () =>
        json({
          version: 'v1',
          createdAt: 1,
          createdBy: null,
          assets: [],
          report: { ok: true, issues: [] },
          active: true,
          displayOnly: false,
          passCount: 0,
          manifest: { ...doc.manifest, blueprint: true },
          passJson: doc.passJson,
        }),
      [`/api/v1/templates/${ID}/use/check`]: (_u: URL, init?: RequestInit) => {
        checks.push(JSON.parse(String(init?.body)));
        return json({
          saved: false,
          version: 'v2',
          created: true,
          displayOnly: false,
          report: { ok: true, issues: [] },
          assets: [],
          passJson: doc.passJson,
          template: null,
        });
      },
      [`/api/v1/templates/${ID}/use`]: (_u: URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(made, 201);
      },
      '/api/v1/templates/made1': () => json(made),
      '/api/v1/templates/made1/preview': preview,
    });
    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Gym balance');
    await user.click(within(dialog).getByRole('button', { name: 'Open designer' }));
    // The designer route loads its own chunk, then the draft replaces the skeleton.
    expect(await screen.findByText('Not saved', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Design Gym balance' })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/admin\/o\/[^/]+\/templates\/new$/);
    expect(screen.getByText('From Balance card')).toBeInTheDocument();
    await waitFor(() => expect(checks.length).toBeGreaterThan(0));
    expect(checks[0]).toMatchObject({ orgId: ORG.id, name: 'Gym balance' });
    // Create template refuses until the check has answered and the local validators have loaded.
    const issues = screen.getByRole('region', { name: 'Issues' });
    await waitFor(() => expect(within(issues).getByRole('status')).not.toHaveTextContent('Checking'));
    await user.click(await screen.findByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ orgId: ORG.id, name: 'Gym balance' });
    expect('blueprint' in (bodies[0]?.version.manifest ?? {})).toBe(false);
    expect(bodies[0]?.version.manifest.name).toBe('Gym balance');
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/admin\/o\/[^/]+\/templates\/made1$/),
    );
  });

  it('on a phone creates the template from the dialog', async () => {
    phone();
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { dialog } = await open(user, {
      [`/api/v1/templates/${ID}/use`]: (_u: URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(made, 201);
      },
      '/api/v1/templates/made1': () => json(made),
      '/api/v1/templates/made1/preview': preview,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(bodies).toEqual([{ orgId: ORG.id, name: 'Balance card' }]));
  });

  it('shows a taken name as the form error', async () => {
    phone();
    const user = userEvent.setup();
    const { dialog } = await open(user, {
      [`/api/v1/templates/${ID}/use`]: () =>
        problem(409, 'TEMPLATE_EXISTS', 'A template with this name exists. Pick another name.'),
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/A template with this name exists/)).toBeInTheDocument();
  });
});

describe('templates', () => {
  it('opens Blueprints from New template; Built-in only on built-in ones', async () => {
    await renderApp('/admin/templates', {
      session: 'admin',
      ...access,
      handlers: {
        '/api/v1/templates/uploads': () => json({ items: [] }),
        '/api/v1/templates': () =>
          json({
            items: [
              templateSummary({ id: 'a', name: 'Gold', passCount: 412 }),
              templateSummary({ id: 'b', name: "Henry's · Copper", origin: 'baked' }),
            ],
            nextCursor: null,
          }),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(await screen.findByRole('link', { name: 'Copper' })).toBeInTheDocument();
    expect(screen.getAllByText('Built-in')).toHaveLength(1);
    expect(screen.queryByText('Uploaded')).toBeNull();
    expect(screen.getByText('412 passes')).toBeInTheDocument();
    expect(target(screen.getByRole('link', { name: 'New template' }))).toBe('/admin/blueprints');
  });

  it('points an empty list at blueprints', async () => {
    await renderApp('/admin/templates', {
      session: 'admin',
      ...access,
      handlers: {
        '/api/v1/templates/uploads': () => json({ items: [] }),
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
    expect(target(screen.getByRole('link', { name: 'Browse blueprints' }))).toBe(
      '/admin/blueprints',
    );
  });

  it('names the blueprint a template came from', async () => {
    await renderApp('/admin/templates/made1', {
      session: 'admin',
      ...access,
      handlers: {
        '/api/v1/templates/made1': () => json({ ...made, activeVersion: 'v1' }),
        '/api/v1/templates/made1/preview': preview,
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    expect(target(await screen.findByRole('link', { name: 'From Balance card' }))).toBe(
      `/admin/blueprints/${ID}`,
    );
  });
});

describe('the new-pass picker', () => {
  const handlers = (items: unknown[]) => ({
    '/api/v1/passes': () => json({ items: [], nextCursor: null }),
    '/api/v1/templates/eligible': () => json({ items, nextCursor: null }),
    '/api/v1/templates/previews': previewsHandler,
    [`/api/v1/templates/${ID}`]: () => json(blueprintDetail()),
  });

  it('lists templates with a way to blueprints', async () => {
    await renderApp(`/admin/passes/new?orgId=${ORG.id}`, {
      session: 'admin',
      memberships: [member],
      handlers: handlers([eligibleTemplate()]),
    });
    expect(await screen.findByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
    expect(target(screen.getByRole('link', { name: 'Browse blueprints' }))).toBe(
      '/admin/blueprints',
    );
  });

  it('sends an organization without templates to blueprints', async () => {
    await renderApp(`/admin/passes/new?orgId=${ORG.id}`, {
      session: 'admin',
      memberships: [member],
      handlers: handlers([]),
    });
    expect(
      await screen.findByText('No eligible templates for this organization and mode'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse blueprints' })).toBeInTheDocument();
  });

  it('explains a blueprint in the link and offers Use blueprint', async () => {
    const user = userEvent.setup();
    await renderApp(`/admin/passes/new?orgId=${ORG.id}&templateId=${encodeURIComponent(ID)}`, {
      session: 'admin',
      memberships: [member],
      handlers: handlers([eligibleTemplate()]),
    });
    expect(
      await screen.findByText('Passes come from templates. Use this blueprint to make one first.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Copper card/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use blueprint' }));
    expect(
      await screen.findByRole('heading', { name: 'Make it yours', level: 1 }),
    ).toBeInTheDocument();
  });
});
