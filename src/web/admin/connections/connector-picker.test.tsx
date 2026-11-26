import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTOR } from '../passes/test-fixtures.ts';
import { ConnectorPicker } from './connector-picker.tsx';
import { buildTiles, matchTiles, tileKey } from './connector-tiles.ts';

const info = (type: string, displayName: string, category: string, order: number, extra = {}) => ({
  ...CONNECTOR,
  type,
  displayName,
  category,
  order,
  description: `${displayName} line.`,
  entitled: true,
  recipes: [],
  ...extra,
});
const sender = (id: string, label: string, category: string, entitled = true) => ({
  id,
  label,
  category,
  entitled,
  pasteSecret: false,
  outputFields: {},
  mapping: {},
  holderEmailField: '',
  voidWhen: [],
});

const SENDERS = [
  sender('shopify-orders', 'Shopify orders', 'commerce'),
  sender('shopify-customers', 'Shopify customers', 'commerce'),
  sender('stripe-subscriptions', 'Stripe subscriptions', 'commerce'),
  sender('stripe-payments', 'Stripe payments', 'commerce'),
  sender('woocommerce-orders', 'WooCommerce orders', 'commerce'),
  sender('calcom-bookings', 'Cal.com bookings', 'bookings'),
  sender('tickettailor-tickets', 'Ticket Tailor tickets', 'bookings'),
];
const ALL = [
  info('demo', 'Demo', 'try', 10),
  info('file-upload', 'File upload', 'files', 10),
  info('csv-url', 'CSV sheet link', 'files', 20),
  info('http-json', 'REST API', 'apis', 10),
  info('webhook-push', 'Webhook push', 'apis', 20, { recipes: SENDERS }),
] as never[];

function setup(connectors = ALL, picked: { type?: string; recipe?: string } = {}) {
  const onPick = vi.fn();
  const onCommit = vi.fn();
  render(
    <ConnectorPicker
      tiles={buildTiles(connectors)}
      type={picked.type}
      recipe={picked.recipe}
      onPick={onPick}
      onCommit={onCommit}
    />,
  );
  return { onPick, onCommit, user: userEvent.setup() };
}

describe('connector tiles', () => {
  it('makes a tile per connector and sender, grouped in order', () => {
    const tiles = buildTiles(ALL);
    expect(tiles).toHaveLength(12);
    expect(tiles.map((t) => t.category)).toEqual([
      'files',
      'files',
      'apis',
      'apis',
      'commerce',
      'commerce',
      'commerce',
      'commerce',
      'commerce',
      'bookings',
      'bookings',
      'try',
    ]);
    const stripe = tiles.find((t) => t.key === 'stripe-payments');
    expect(stripe).toMatchObject({ type: 'webhook-push', recipe: 'stripe-payments' });
  });

  it('leaves out what the plan does not allow', () => {
    const trial = [
      ...ALL.slice(0, 4),
      info('webhook-push', 'Webhook push', 'apis', 20, {
        recipes: SENDERS.map((r) => ({ ...r, entitled: r.id.startsWith('s') })),
      }),
    ] as never[];
    expect(buildTiles(trial).map((t) => t.key)).not.toContain('woocommerce-orders');
    const noCustom = [
      info('webhook-push', 'Webhook push', 'apis', 20, { entitled: false, recipes: SENDERS }),
    ];
    expect(buildTiles(noCustom as never[]).map((t) => t.key)).not.toContain('webhook-push');
  });

  it('keys a tile by its sender, Custom by the connector', () => {
    expect(tileKey('webhook-push', 'stripe-payments')).toBe('stripe-payments');
    expect(tileKey('webhook-push', 'custom')).toBe('webhook-push');
    expect(tileKey('csv-url', undefined)).toBe('csv-url');
  });

  it('matches every word against label, group and keywords', () => {
    const tiles = buildTiles(ALL);
    expect(matchTiles(tiles, 'excel').map((t) => t.key)).toEqual(['file-upload']);
    expect(matchTiles(tiles, 'google').map((t) => t.key)).toEqual(['csv-url']);
    expect(matchTiles(tiles, 'shopify').map((t) => t.key)).toEqual([
      'shopify-orders',
      'shopify-customers',
    ]);
    expect(matchTiles(tiles, 'bookings cal').map((t) => t.key)).toEqual(['calcom-bookings']);
    expect(matchTiles(tiles, 'zzz')).toEqual([]);
  });
});

describe('connector picker', () => {
  it('groups and searches above the thresholds', () => {
    setup();
    expect(screen.getByRole('searchbox', { name: 'Search connectors' })).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Files and sheets' })).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Bookings and tickets' })).toBeVisible();
    expect(screen.getAllByRole('radio')).toHaveLength(12);
  });

  it('shows one plain list with no search for a few tiles', () => {
    setup(ALL.slice(0, 4));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
  });

  it('groups without search at nine tiles', () => {
    setup([
      ...ALL.slice(0, 4),
      info('webhook-push', 'Webhook push', 'apis', 20, { recipes: SENDERS.slice(0, 4) }),
    ] as never[]);
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Commerce' })).toBeVisible();
  });

  it('filters by search and shows the empty state', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('searchbox'), 'excel');
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([
      'file-upload',
    ]);
    expect(screen.queryByRole('radiogroup', { name: 'APIs' })).toBeNull();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText('No connector matches')).toBeVisible();
  });

  it('moves with arrow keys through the flat order and commits on Enter', async () => {
    const { user, onPick, onCommit } = setup();
    await user.type(screen.getByRole('searchbox'), '{ArrowDown}');
    expect(screen.getByRole('radio', { name: /File upload/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'http-json' }));
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ key: 'http-json' }));
  });

  it('commits the first match on Enter in search', async () => {
    const { user, onPick, onCommit } = setup();
    await user.type(screen.getByRole('searchbox'), 'stripe pay{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ recipe: 'stripe-payments' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('checks the picked sender, not the webhook connector', () => {
    setup(ALL, { type: 'webhook-push', recipe: 'calcom-bookings' });
    expect(screen.getByRole('radio', { name: /Cal.com bookings/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Webhook push/ })).not.toBeChecked();
  });
});
