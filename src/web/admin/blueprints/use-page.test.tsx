import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassSetupResult } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { setCsrfProvider } from '../../lib/api.ts';
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

const ID = 'baked:starter-monthly-pass';
const member = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const blueprint = templateDetail({
  ...templateSummary({ id: ID, orgId: null, orgName: null, name: 'Monthly pass', blueprint: true }),
  activeVersion: null,
});
const made = templateDetail({ id: 'made1', name: 'Gym membership', activeVersion: null });
const findName = () => screen.findByRole('textbox', { name: /Name/ });
const preview = () =>
  json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] });

beforeEach(() => setCsrfProvider(async () => 'csrf'));
afterEach(() => {
  clearPreviewBatches();
  vi.unstubAllGlobals();
  setCsrfProvider(async () => undefined);
});

function open(extra: Record<string, never | ((u: URL, i?: RequestInit) => Response)> = {}) {
  return renderApp(`/admin/o/${ORG.id}/blueprints/${ID}/use`, {
    session: 'admin',
    memberships: [member],
    selectedOrg: ORG.id,
    handlers: {
      [`/api/v1/templates/${ID}`]: () => json(blueprint),
      [`/api/v1/templates/${ID}/preview`]: preview,
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/made1': () => json(made),
      '/api/v1/templates/made1/preview': preview,
      ...extra,
    },
  });
}

type User = ReturnType<typeof userEvent.setup>;
/** Name to Look. */
const toLook = async (user: User) =>
  user.click(await screen.findByRole('button', { name: 'Next' }));
/** Look to Review, then Create. */
async function create(user: User) {
  await user.click(screen.getByRole('button', { name: /^(Next|Review)$/ }));
  await user.click(await screen.findByRole('button', { name: 'Create template' }));
}

describe('Make it yours', () => {
  it('creates the template with the name and opens it', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { router, container } = await open({
      [`/api/v1/templates/${ID}/use`]: (_u: URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(made, 201);
      },
      [`/api/v1/orgs/${ORG.id}/pass-setup`]: () => json(viewOf(readyFacts())),
    });
    const name = await screen.findByRole('textbox', { name: /Name/ });
    expect(screen.getByRole('heading', { name: 'Make it yours', level: 1 })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await user.clear(name);
    await user.type(name, 'Gym membership');
    await toLook(user);
    await create(user);
    await waitFor(() => expect(bodies).toEqual([{ orgId: ORG.id, name: 'Gym membership' }]));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/admin/o/${ORG.id}/templates/made1`),
    );
  });

  it('asks for a name', async () => {
    const user = userEvent.setup();
    await open();
    await user.clear(await screen.findByRole('textbox', { name: /Name/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Name the template' })).toBeInTheDocument();
  });

  it('writes the colour to the organization brand when Use for all passes is on', async () => {
    const user = userEvent.setup();
    const patches: { expectedRevision: string; brand: { passColors: Record<string, string> } }[] =
      [];
    const view = viewOf(newOrgFacts());
    await open({
      [`/api/v1/templates/${ID}/use`]: () => json(made, 201),
      [`/api/v1/orgs/${ORG.id}/pass-setup`]: (_u: URL, init?: RequestInit) => {
        if (init?.method !== 'PATCH') return json(view);
        patches.push(JSON.parse(String(init.body)));
        return json({
          saved: true,
          view,
          diff: [],
          impact: { passesToUpdate: 0, channelStops: [] },
        } as unknown as PassSetupResult);
      },
    });
    await toLook(user);
    const toggle = await screen.findByRole('switch', { name: 'Use for all passes' });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.change(screen.getByLabelText('Custom colour'), { target: { value: '#0f766e' } });
    await create(user);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.expectedRevision).toBe(view.revision);
    expect(patches[0]?.brand.passColors.background).toBe('#0f766e');
  });

  it('lists Use for all passes in Review only when something would reach the brand', async () => {
    const user = userEvent.setup();
    await open({ [`/api/v1/orgs/${ORG.id}/pass-setup`]: () => json(viewOf(newOrgFacts())) });
    await findName();
    await toLook(user);
    await screen.findByRole('switch', { name: 'Use for all passes' });
    await user.click(screen.getByRole('button', { name: /^(Next|Review)$/ }));
    expect(await screen.findByRole('heading', { name: 'Check and create' })).toBeVisible();
    expect(screen.queryByText('Use for all passes')).toBeNull();
    expect(screen.queryByText(/won't carry over/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit look' }));
    fireEvent.change(await screen.findByLabelText('Custom colour'), {
      target: { value: '#0f766e' },
    });
    await user.click(screen.getByRole('button', { name: /^(Next|Review)$/ }));
    expect(await screen.findByText('Use for all passes')).toBeVisible();
    expect(screen.getByText(/won't carry over to the designer/)).toBeVisible();
  });

  it('starts off for an organization that has its own pass brand', async () => {
    const user = userEvent.setup();
    await open({ [`/api/v1/orgs/${ORG.id}/pass-setup`]: () => json(viewOf(readyFacts())) });
    await findName();
    await toLook(user);
    const toggle = await screen.findByRole('switch', { name: 'Use for all passes' });
    expect(toggle).not.toBeChecked();
  });

  it('keeps the organization brand read only until Override, and writes nothing to it', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    const view = viewOf(readyFacts());
    await open({
      [`/api/v1/orgs/${ORG.id}/pass-setup`]: (_u: URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') patches.push(init.body);
        return json(view);
      },
    });
    await findName();
    await toLook(user);
    const overrides = await screen.findAllByRole('button', { name: 'Override for this template' });
    expect(screen.getAllByText('From organization').length).toBe(overrides.length);
    await user.click(overrides[0] as HTMLElement);
    expect(screen.getAllByText('From organization').length).toBe(overrides.length - 1);
    await create(user);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create template' })).toBeEnabled(),
    );
    expect(patches).toEqual([]);
  });

  it('leaves the colour out of the template when it goes to the organization, and keeps it own otherwise', async () => {
    const user = userEvent.setup();
    const doc = sampleDoc();
    const bodies: { version?: { manifest: { brand?: Record<string, string> } } }[] = [];
    const view = viewOf(newOrgFacts());
    await open({
      [`/api/v1/templates/${ID}`]: () => json({ ...blueprint, activeVersion: 'v1' }),
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
        bodies.push(JSON.parse(String(init?.body)));
        return json(made, 201);
      },
      [`/api/v1/orgs/${ORG.id}/pass-setup`]: (_u: URL, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? json({ saved: true, view, diff: [], impact: { passesToUpdate: 0, channelStops: [] } })
          : json(view),
    });
    await toLook(user);
    const toggle = await screen.findByRole('switch', { name: 'Use for all passes' });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.change(screen.getByLabelText('Custom colour'), { target: { value: '#0f766e' } });
    await create(user);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.version?.manifest.brand?.colors).toBeUndefined();
    await waitFor(() => expect(toggle).toBeEnabled());
  });
});
