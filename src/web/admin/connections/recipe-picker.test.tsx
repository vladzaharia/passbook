import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, connection, connectionDetail, ORG } from '../passes/test-fixtures.ts';
import { GUIDES, setupOf } from './setup-fixtures.ts';

const STRIPE = {
  id: 'stripe-subscriptions',
  label: 'Stripe subscriptions',
  line: 'Subscription to membership.',
  secretOrigin: 'provider',
  pasteSecret: true,
  entitled: true,
  outputFields: { status: { type: 'string' }, plan: { type: 'string' } },
  mapping: { tier: { from: '/plan' } },
  holderEmailField: '/email',
  voidWhen: [{ from: '/status', op: 'in', values: ['canceled', 'incomplete_expired'] }],
};
const CAL = {
  ...STRIPE,
  id: 'calcom-bookings',
  label: 'Cal.com bookings',
  pasteSecret: false,
  secretOrigin: 'passbook',
  voidWhen: [],
};
const WEBHOOK = {
  ...CONNECTOR,
  entitled: true,
  type: 'webhook-push',
  displayName: 'Webhook push',
  description: 'Your system sends signed records.',
  capabilities: { poll: false, delta: false, webhook: true, import: false, snapshot: false },
  configSchema: {
    type: 'object',
    properties: {
      recipe: {
        type: 'string',
        enum: ['custom', 'stripe-subscriptions', 'calcom-bookings'],
        default: 'custom',
        'x-label': 'Sender',
      },
      recordsPointer: { type: 'string', default: '/records', 'x-label': 'Records' },
    },
  },
  secretSchema: null,
  recipes: [STRIPE, CAL],
};

type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) =>
  user.click(screen.getByRole('button', { name: /^(Next|Create( without mappings)?)$/ }));

function setup(posts: Record<string, unknown>[], connector: Record<string, unknown> = WEBHOOK) {
  return renderApp('/admin/connections/new', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/connectors': () => json({ items: [connector], nextCursor: null }),
      '/api/v1/connectors/webhook-push': () => json(connector),
      '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      '/api/v1/connections': (_u: URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          const body = JSON.parse(String(init?.body));
          posts.push(body);
          // PassBook is the origin for Cal.com: the server makes the secret and returns it once.
          const made =
            body.config?.recipe === 'calcom-bookings' ? { webhookSecret: 'f'.repeat(64) } : {};
          return json(
            { ...connection({ id: 'c9', webhookUrl: 'https://wallet.example/h/c9' }), ...made },
            201,
          );
        }
        return json({ items: [], nextCursor: null });
      },
      '/api/v1/connections/c9': () => json(connectionDetail({ id: 'c9' })),
      '/api/v1/connectors/webhook-push/recipes/stripe-subscriptions/setup': () =>
        json(GUIDES['stripe-subscriptions']),
      '/api/v1/connectors/webhook-push/recipes/calcom-bookings/setup': () =>
        json(GUIDES['calcom-bookings']),
      '/api/v1/connections/c9/setup': () => json(setupOf(handoff.recipe, handoff.values)),
      '/api/v1/connections/c9/webhook-arrivals': () => json({ items: [], nextCursor: null }),
    },
  });
}

const handoff: {
  recipe: 'stripe-subscriptions' | 'calcom-bookings';
  values: Record<string, unknown>;
} = {
  recipe: 'stripe-subscriptions',
  values: { hasSecret: false },
};

describe('webhook sender picker', () => {
  it('seeds the sender and creates with its void rules, asking for no secret before Create', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    handoff.recipe = 'stripe-subscriptions';
    handoff.values = { hasSecret: false };
    const { router } = await setup(posts);
    // A sender is a tile in the picker; the plain webhook tile is Custom.
    await user.click(await screen.findByRole('radio', { name: /Webhook push/ }));
    await user.click(screen.getByRole('radio', { name: /Stripe subscriptions/ }));
    await next(user);
    await user.type(await screen.findByLabelText(/^Name/), 'Gym billing');
    // The custom pointers belong to Custom only, and Setup has no sender picker.
    expect(screen.queryByLabelText('Records')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Sender' })).toBeNull();
    // The sender makes the secret after the webhook exists there: nothing to paste yet.
    expect(screen.queryByLabelText(/Signing secret/)).toBeNull();
    // The rail names the sender's side from its guide.
    expect(await screen.findByRole('group', { name: 'In Stripe' })).toBeInTheDocument();
    await next(user);
    await next(user);
    // Issuing: holder email and the void rule come from the sender.
    expect(await screen.findByDisplayValue('/email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/status')).toBeInTheDocument();
    expect(screen.getByDisplayValue('canceled, incomplete_expired')).toBeInTheDocument();
    expect(screen.getByText('Voided passes stay voided.')).toBeInTheDocument();
    await next(user);
    expect(screen.getByText(/add the webhook in Stripe/)).toBeInTheDocument();
    await next(user);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      connectorType: 'webhook-push',
      config: { recipe: 'stripe-subscriptions' },
      holderEmailField: '/email',
      mapping: { tier: { from: '/plan' } },
      voidWhen: [{ from: '/status', op: 'in', values: ['canceled', 'incomplete_expired'] }],
    });
    expect(posts[0]).not.toHaveProperty('webhookSecret');
    // The sender's own side: Connect first, its secret pasted after.
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/\/connections\/c9\/setup$/),
    );
    expect(await screen.findByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
  });

  it('leaves the secret to the server for a sender that takes ours', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    handoff.recipe = 'calcom-bookings';
    handoff.values = { hasSecret: true };
    await setup(posts);
    await user.click(await screen.findByRole('radio', { name: /Cal.com bookings/ }));
    await next(user);
    await user.type(await screen.findByLabelText(/^Name/), 'Bookings');
    expect(screen.queryByLabelText(/Signing secret/)).toBeNull();
    for (let i = 0; i < 4; i++) await next(user);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('webhookSecret');
    expect(await screen.findByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
  });

  it('hides the senders a plan leaves out, Custom included', async () => {
    const _user = userEvent.setup();
    await setup([], {
      ...WEBHOOK,
      entitled: false,
      recipes: [STRIPE, { ...CAL, entitled: false }],
    });
    expect(await screen.findByRole('radio', { name: /Stripe subscriptions/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Webhook push/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Cal.com/ })).toBeNull();
  });
});
