import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, ORG, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import { datasetOfSample, kindOf, showValue, suggestedFirst } from './demo/datasets.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });

const prop = (label: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  'x-label': label,
  ...extra,
});
const DEMO = {
  ...CONNECTOR,
  type: 'demo',
  displayName: 'Demo',
  description: 'Sample records.',
  capabilities: { poll: true, delta: false, webhook: false, import: false, snapshot: false },
  configSchema: {
    type: 'object',
    properties: {
      dataset: prop('Dataset', { enum: ['classic', 'gym-members', 'hotel-stays'] }),
      count: { type: 'integer', 'x-label': 'Records', default: 25 },
      seed: prop('Seed', { default: 'demo' }),
      locale: prop('Locale', { enum: ['en-US', 'de-DE'], default: 'en-US' }),
      anchor: prop('Anchor date'),
      revision: { type: 'integer', 'x-label': 'Revision', default: 0 },
      changeRate: { type: 'integer', 'x-label': 'Change rate (%)', default: 20 },
      holderDomain: prop('Holder domain', { default: 'example.com' }),
      fail: prop('Simulated failure', { enum: ['none', 'auth'], default: 'none' }),
    },
  },
  secretSchema: null,
  outputFields: {},
};

const SAMPLES: Record<string, { pointer: string; preview: string }[]> = {
  'gym-members': [
    { pointer: '/memberName', preview: 'Carole Terry' },
    { pointer: '/memberId', preview: 'M-148271' },
    { pointer: '/homeClub', preview: 'Kenosha Riverside' },
    { pointer: '/validUntil', preview: '2026-02-02T00:00:00-08:00' },
  ],
  'hotel-stays': [
    { pointer: '/guest', preview: 'Keshawn Aufderhar' },
    { pointer: '/reservation', preview: 'RES-148271' },
    { pointer: '/room', preview: '101' },
  ],
};

const media = window.matchMedia;
afterEach(() => {
  window.matchMedia = media;
});

/** The wizard stages its aside from 1024 px. */
function staged() {
  window.matchMedia = ((query: string) => ({
    ...media(query),
    matches: query.includes('min-width: 1024px') || media(query).matches,
  })) as typeof window.matchMedia;
}

describe('demo in the wizard', () => {
  it('starts on Gym members, tests on every pick and shows the record card', async () => {
    const user = userEvent.setup();
    const testPosts: Record<string, unknown>[] = [];
    staged();
    await renderApp('/admin/connections/new', {
      session: 'admin',
      memberships: [membership],
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connectors': () => json({ items: [DEMO], nextCursor: null }),
        '/api/v1/connectors/demo': () => json(DEMO),
        '/api/v1/templates': () =>
          json({
            items: [
              templateSummary({ id: 'tpl1', name: 'Copper card' }),
              templateSummary({
                id: 'tpl2',
                name: 'Gym pass',
                fromBlueprint: { id: 'bp1', name: 'Monthly pass' },
              }),
            ],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/connections/test-config': (_u, init) => {
          const body = JSON.parse(String(init?.body)) as { config: { dataset: string } };
          testPosts.push(body.config);
          return json({
            ok: true,
            durationMs: 3,
            sample: SAMPLES[body.config.dataset] ?? [],
          });
        },
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Demo/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const picker = await screen.findByRole('radiogroup', { name: 'Dataset' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(9);
    expect(within(picker).getByRole('radio', { name: /Gym members/ })).toBeChecked();
    await waitFor(() => expect(testPosts).toHaveLength(1));
    expect(testPosts[0]).toMatchObject({ dataset: 'gym-members' });
    expect(await screen.findByText('Kenosha Riverside')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 4 fields' })).toBeInTheDocument();
    expect(screen.getByLabelText('Members')).toBeInTheDocument();

    await user.click(within(picker).getByRole('radio', { name: /Hotel stays/ }));
    await waitFor(() => expect(testPosts).toHaveLength(2));
    expect(testPosts[1]).toMatchObject({ dataset: 'hotel-stays' });
    expect(await screen.findByText('RES-148271')).toBeInTheDocument();
    expect(screen.getByLabelText('Stays')).toBeInTheDocument();

    // Failures sit behind a fold.
    expect(screen.getByText('Simulate failures').closest('details')).not.toHaveAttribute('open');
  });
});

describe('demo datasets', () => {
  it('reads a sample back to its dataset', () => {
    expect(datasetOfSample(SAMPLES['gym-members'] ?? [])?.id).toBe('gym-members');
    expect(datasetOfSample([{ pointer: '/name' }, { pointer: '/email' }])?.id).toBe('classic');
    expect(datasetOfSample([{ pointer: '/x' }])).toBeUndefined();
  });

  it('types and formats previews', () => {
    expect(kindOf('2026-01-05')).toBe('date');
    expect(kindOf('12.5')).toBe('number');
    expect(kindOf('a@example.com')).toBe('email');
    expect(kindOf('true')).toBe('toggle');
    expect(kindOf('["a","b"]')).toBe('list');
    expect(showValue('2026-02-02T00:00:00-08:00')).toMatch(/Feb 2, 2026/);
    expect(showValue('["lobby","gym"]')).toBe('lobby, gym');
  });

  it('puts templates from the dataset blueprints first', () => {
    const items = [
      { id: 'a', fromBlueprint: null },
      { id: 'b', fromBlueprint: { name: 'Access card' } },
    ];
    expect(suggestedFirst(items, 'gym-members').suggested.map((t) => t.id)).toEqual(['b']);
    expect(suggestedFirst(items, 'classic').suggested).toEqual([]);
  });
});
