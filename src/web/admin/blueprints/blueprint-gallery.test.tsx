import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  ORG,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';
import { sampleDoc } from '../templates/designer/fixtures.ts';

const member = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const access = { memberships: [member], selectedOrg: ORG.id };
const preview = () =>
  json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] });
const bp = (slug: string, name: string, over: Record<string, unknown> = {}) =>
  templateSummary({
    id: `baked:starter-${slug}`,
    orgId: null,
    orgName: null,
    name,
    description: `${name} line.`,
    origin: 'baked',
    blueprint: true,
    activeVersion: 'v1',
    icon: 'id-card',
    styles: ['generic'],
    passCount: 0,
    ...over,
  });
const CATALOG = [
  bp('event-ticket', 'Event ticket', { group: 'get-in', aliases: ['concert'] }),
  bp('access-card', 'Access card', { group: 'get-in', aliases: ['gym'] }),
  bp('stamp-card', 'Stamp card', { group: 'save-spend', aliases: ['punch card'] }),
  bp('store-card', 'Balance card', { group: 'save-spend', aliases: ['gift'] }),
  bp('generic', 'Membership card', { group: 'membership-id', aliases: ['library'] }),
];
const catalog = (items: unknown[]) => ({
  '/api/v1/templates': () => json({ items, nextCursor: null }),
  '/api/v1/templates/previews': previewsHandler,
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
  delete document.documentElement.dataset.theme;
});

describe('gallery groups and search', () => {
  it('shows the jobs in order, with the blueprints of each', async () => {
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog(CATALOG),
    });
    await screen.findByRole('list', { name: 'Get people in' });
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(heads).toEqual(['Get people in2', 'Save and spend2', 'Membership and ID1']);
    const saved = screen.getByRole('list', { name: 'Save and spend' });
    expect(
      within(saved)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Stamp card', 'Balance card']);
  });

  it('finds a blueprint by an alias, and says when nothing matches', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog(CATALOG),
    });
    const search = await screen.findByRole('searchbox', { name: 'Search blueprints' });
    await user.type(search, 'gift');
    expect(screen.getByRole('link', { name: 'Balance card' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Event ticket' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Get people in/ })).toBeNull();
    await user.clear(search);
    await user.type(search, 'punch card');
    expect(screen.getByRole('link', { name: 'Stamp card' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'ferry');
    expect(await screen.findByText('No blueprints match')).toBeInTheDocument();
  });

  it('puts the Staff badge behind the Access card once it exists', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog([
        ...CATALOG,
        bp('staff-badge', 'Staff badge', { group: 'get-in', aliases: ['employee'] }),
      ]),
    });
    expect(await screen.findByRole('link', { name: 'Access card' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Staff badge' })).toBeNull();
    const choice = screen.getByRole('radiogroup', { name: 'Access card for' });
    await user.click(within(choice).getByRole('radio', { name: 'Business' }));
    expect(screen.getByRole('link', { name: 'Staff badge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Staff badge' })).toBeInTheDocument();
    // The alias of either one finds the tile.
    await user.type(screen.getByRole('searchbox', { name: 'Search blueprints' }), 'employee');
    expect(screen.getByRole('link', { name: 'Staff badge' })).toBeInTheDocument();
  });

  it('shows the Access card alone while there is no Staff badge', async () => {
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog(CATALOG),
    });
    await screen.findByRole('link', { name: 'Access card' });
    expect(screen.queryByRole('radiogroup', { name: 'Access card for' })).toBeNull();
  });
});

type Body = {
  orgId: string;
  name: string;
  version: {
    passJson: Record<string, string>;
    manifest: Record<string, unknown>;
    assets: { name: string; upload?: string }[];
  };
};
const emptyImpact = { passesToUpdate: 0, channelStops: [], enrolments: [] };
const ID = 'baked:starter-store-card';
const made = templateDetail({
  id: 'made1',
  name: 'Gym balance',
  activeVersion: null,
  fromBlueprint: { id: ID, name: 'Balance card' },
});
/** A PNG header with the given size: all the slot check reads. */
function logoFile(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], 'logo.png', { type: 'image/png' });
}

describe('quick setup', () => {
  /** The blueprint, its use route and the org's pass setup: what Use blueprint reads and writes. */
  const useHandlers = (
    setup: PassSetup,
    bodies: { template: Body[]; patch: Record<string, unknown>[]; staged: unknown[] },
  ) => {
    const doc = sampleDoc();
    return {
      ...catalog([bp('store-card', 'Balance card', { group: 'save-spend' })]),
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
      [`/api/v1/templates/${ID}/use`]: (_u: URL, init?: RequestInit) => {
        bodies.template.push(JSON.parse(String(init?.body)));
        return json(made, 201);
      },
      '/api/v1/templates/made1': () => json(made),
      '/api/v1/templates/made1/preview': preview,
      [`/api/v1/orgs/${ORG.id}/pass-setup`]: (_u: URL, init?: RequestInit) => {
        if (init?.method !== 'PATCH') return json(setup);
        bodies.patch.push(JSON.parse(String(init.body)));
        return json({ dryRun: false, view: setup, diff: [], impact: emptyImpact });
      },
      [`/api/v1/orgs/${ORG.id}/brand-assets`]: (_u: URL, init?: RequestInit) => {
        bodies.staged.push(JSON.parse(String(init?.body)));
        return json({
          slot: 'logo',
          sha: 'c'.repeat(64),
          version: 'c'.repeat(64),
          w: 200,
          h: 60,
          expiresAt: 2_000_000_000_000,
        });
      },
    };
  };
  const pickLogoAndColour = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Use Balance card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use blueprint' });
    await waitFor(() => expect(dialog).toHaveTextContent('Colour'));
    return dialog;
  };
  const addLogo = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
    await user.upload(
      within(dialog).getByLabelText('Choose a PNG logo', { selector: 'input' }),
      logoFile(200, 60),
    );
    expect(await within(dialog).findByText('logo.png')).toBeInTheDocument();
    fireColor(within(dialog).getByLabelText('Custom colour'), '#aa3311');
  };
  const sent = () => ({ template: [] as Body[], patch: [], staged: [] });

  it('with no organization brand yet, the logo and colour become the organization brand', async () => {
    phone();
    const user = userEvent.setup();
    const bodies = sent();
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: useHandlers(viewOf(newOrgFacts()), bodies),
    });
    const dialog = await pickLogoAndColour(user);
    expect(within(dialog).queryByRole('button', { name: 'Open designer' })).toBeNull();
    await addLogo(user, dialog);
    expect(within(dialog).getByText('Saved as the organization logo.')).toBeInTheDocument();
    expect(within(dialog).getByText('Saved as the organization colours.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(bodies.template).toHaveLength(1));
    // One staged save of the organization brand: the logo by its hash and the colours.
    expect(bodies.staged).toHaveLength(1);
    expect(bodies.patch).toHaveLength(1);
    expect(bodies.patch[0]).toMatchObject({
      expectedRevision: 'r1',
      brand: {
        logo: { sha: 'c'.repeat(64) },
        passColors: { background: 'rgb(170,51,17)', foreground: 'rgb(255,255,255)' },
      },
    });
    // The template is the blueprint as it is: no logo, no colours, no opt-out.
    expect(bodies.template[0]).toMatchObject({ orgId: ORG.id, name: 'Balance card' });
    expect('version' in (bodies.template[0] ?? {})).toBe(false);
    expect(await screen.findByText('Template created')).toBeInTheDocument();
  });

  it('with an organization brand, shows it read only and keeps the template own only on Override', async () => {
    phone();
    const user = userEvent.setup();
    const bodies = sent();
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: useHandlers(viewOf(readyFacts()), bodies),
    });
    const dialog = await pickLogoAndColour(user);
    expect(within(dialog).getAllByText('From organization')).toHaveLength(2);
    expect(within(dialog).queryByLabelText('Choose a PNG logo', { selector: 'input' })).toBeNull();
    const [logo, colour] = within(dialog).getAllByRole('button', {
      name: 'Override for this template',
    });
    await user.click(logo as HTMLElement);
    await user.click(colour as HTMLElement);
    await addLogo(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(bodies.template).toHaveLength(1));
    expect(bodies.patch).toHaveLength(0);
    const body = bodies.template[0];
    expect(body?.version.passJson.backgroundColor).toBe('rgb(170,51,17)');
    expect(body?.version.manifest.brand).toEqual({ colors: 'template', logo: 'template' });
    expect(body?.version.assets.some((a) => a.name.startsWith('logo') && a.upload)).toBe(true);
  });

  it('without the right to change the organization brand, the template keeps its own and says so', async () => {
    phone();
    const user = userEvent.setup();
    const bodies = sent();
    const author = membershipFixture(ORG.id, {
      orgName: ORG.name,
      orgSlug: ORG.slug,
      capabilities: ['templates:author', 'templates:read'],
    });
    await renderApp('/admin/blueprints', {
      session: 'admin',
      memberships: [author],
      selectedOrg: ORG.id,
      handlers: useHandlers(viewOf(newOrgFacts()), bodies),
    });
    const dialog = await pickLogoAndColour(user);
    await addLogo(user, dialog);
    expect(within(dialog).queryByText('Saved as the organization logo.')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(bodies.template).toHaveLength(1));
    expect(bodies.patch).toHaveLength(0);
    expect(bodies.template[0]?.version.manifest.brand).toEqual({
      colors: 'template',
      logo: 'template',
    });
  });

  it('offers the stamps goal and the currency, and sends the choices', async () => {
    phone();
    const user = userEvent.setup();
    const doc = sampleDoc();
    const inputs = doc.manifest.inputs as { properties: Record<string, unknown> };
    inputs.properties.currency = { type: 'string', enum: ['USD', 'EUR'], default: 'USD' };
    inputs.properties.stamps = { type: 'integer', maximum: 19 };
    const manifest = { ...doc.manifest, stamps: { input: 'stamps', goal: 10, art: {} } };
    const bodies: { version: { manifest: Record<string, unknown> } }[] = [];
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: {
        ...catalog([bp('store-card', 'Balance card', { group: 'save-spend' })]),
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
            manifest,
            passJson: doc.passJson,
          }),
        [`/api/v1/templates/${ID}/use`]: (_u: URL, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(made, 201);
        },
        '/api/v1/templates/made1': () => json(made),
        '/api/v1/templates/made1/preview': preview,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Use Balance card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use blueprint' });
    await user.click(await within(dialog).findByRole('combobox', { name: 'Stamps for a reward' }));
    await user.click(await screen.findByRole('option', { name: '8' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Currency' }));
    await user.click(await screen.findByRole('option', { name: 'CAD' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = bodies[0]?.version.manifest as {
      stamps: { goal: number };
      sample: { currency: string };
    };
    expect(sent.stamps.goal).toBe(8);
    expect(sent.sample.currency).toBe('CAD');
  });

  it('refuses a logo that is not a PNG', async () => {
    phone();
    const user = userEvent.setup();
    await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog([bp('store-card', 'Balance card', { group: 'save-spend' })]),
    });
    await user.click(await screen.findByRole('button', { name: 'Use Balance card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use blueprint' });
    await user.upload(
      within(dialog).getByLabelText('Choose a PNG logo', { selector: 'input' }),
      new File(['x'], 'logo.png', { type: 'image/png' }),
    );
    expect(await within(dialog).findByText('Use a PNG file.')).toBeInTheDocument();
  });
});

function fireColor(input: HTMLElement, value: string) {
  // A colour input takes its value from the platform's own setter, so the change event carries it.
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('blueprint page', () => {
  it('shows what staff see next to the pass, and the other screen on a choice', async () => {
    const user = userEvent.setup();
    const doc = sampleDoc();
    await renderApp(`/admin/blueprints/${ID}`, {
      session: 'admin',
      ...access,
      handlers: {
        [`/api/v1/templates/${ID}`]: () =>
          json(templateDetail({ ...bp('store-card', 'Balance card'), id: ID })),
        [`/api/v1/templates/${ID}/preview`]: preview,
        '/api/v1/templates/previews': previewsHandler,
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
      },
    });
    expect(await screen.findByRole('heading', { name: 'What staff see' })).toBeInTheDocument();
    expect(await screen.findByText('Checked in')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Already used' }));
    expect(await screen.findByText('Already checked in')).toBeInTheDocument();
  });
});

const COMBOS = [1440, 820, 390].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => [width, theme] as const),
);

describe.each(COMBOS)('axe at %i, %s theme', (width, theme) => {
  it('gallery and the Use dialog', async () => {
    document.documentElement.dataset.theme = theme;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    if (width < 640) phone();
    const user = userEvent.setup();
    const { container } = await renderApp('/admin/blueprints', {
      session: 'admin',
      ...access,
      handlers: catalog([...CATALOG, bp('staff-badge', 'Staff badge', { group: 'get-in' })]),
    });
    await screen.findByRole('list', { name: 'Get people in' });
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: /^Use / })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Use blueprint' });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
