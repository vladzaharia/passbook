import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, connection, connectionDetail, ORG } from '../passes/test-fixtures.ts';

const STRIPE = {
  id: 'stripe-subscriptions',
  label: 'Stripe subscriptions',
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
          posts.push(JSON.parse(String(init?.body)));
          return json(connection({ id: 'c9', webhookUrl: 'https://wallet.example/h/c9' }), 201);
        }
        return json({ items: [], nextCursor: null });
      },
      '/api/v1/connections/c9': () => json(connectionDetail({ id: 'c9' })),
    },
  });
}

describe('webhook sender picker', () => {
  it('seeds the sender, asks for a pasted secret and creates with its void rules', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await setup(posts);
    await user.click(await screen.findByRole('radio', { name: /Webhook push/ }));
    await next(user);
    expect(await screen.findByRole('radio', { name: /Custom/ })).toBeChecked();
    expect(screen.getByLabelText('Records')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), 'Gym billing');
    await user.click(screen.getByRole('radio', { name: /Stripe subscriptions/ }));
    // The custom pointers belong to Custom only.
    expect(screen.queryByLabelText('Records')).toBeNull();
    await next(user);
    expect(await screen.findByText('Paste the signing secret.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Signing secret/), 'secret-without-prefix');
    await next(user);
    expect(
      await screen.findByText('A Stripe signing secret starts with whsec_.'),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Signing secret/));
    await user.type(screen.getByLabelText(/Signing secret/), 'whsec_demo_demo_demo');
    await next(user);
    await next(user);
    // Lifecycle: holder email and the void rule come from the sender.
    expect(await screen.findByDisplayValue('/email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/status')).toBeInTheDocument();
    expect(screen.getByDisplayValue('canceled, incomplete_expired')).toBeInTheDocument();
    expect(screen.getByText('Voided passes stay voided.')).toBeInTheDocument();
    await next(user);
    await next(user);
    // The sender made the secret, so the created page has none to show; it names the topics.
    expect(await screen.findByText(/subscribe to: checkout.session.completed/)).toBeInTheDocument();
    expect(screen.queryByText('Signing secret')).toBeNull();
    expect(posts[0]).toMatchObject({
      connectorType: 'webhook-push',
      config: { recipe: 'stripe-subscriptions' },
      webhookSecret: 'whsec_demo_demo_demo',
      holderEmailField: '/email',
      mapping: { tier: { from: '/plan' } },
      voidWhen: [{ from: '/status', op: 'in', values: ['canceled', 'incomplete_expired'] }],
    });
  });

  it('generates the secret for a sender that takes ours', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await setup(posts);
    await user.click(await screen.findByRole('radio', { name: /Webhook push/ }));
    await next(user);
    await user.type(await screen.findByLabelText(/^Name/), 'Bookings');
    await user.click(screen.getByRole('radio', { name: /Cal.com bookings/ }));
    expect(screen.queryByLabelText(/Signing secret/)).toBeNull();
    await next(user);
    await next(user);
    await next(user);
    await next(user);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(await screen.findByText(/subscribe to: BOOKING_CREATED/)).toBeInTheDocument();
    expect(screen.getByText('Signing secret')).toBeInTheDocument();
  });

  it('hides the senders a plan leaves out, Custom included', async () => {
    const user = userEvent.setup();
    await setup([], {
      ...WEBHOOK,
      entitled: false,
      recipes: [STRIPE, { ...CAL, entitled: false }],
    });
    await user.click(await screen.findByRole('radio', { name: /Webhook push/ }));
    await next(user);
    expect(await screen.findByRole('radio', { name: /Stripe subscriptions/ })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /Custom/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Cal.com/ })).toBeNull();
  });
});
