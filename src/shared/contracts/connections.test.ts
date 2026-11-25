import { describe, expect, it } from 'vitest';
import {
  ConnectorInfoSchema,
  CreateConnectionSchema,
  RecipeIdSchema,
  SecretOverlapSchema,
  UpdateConnectionSchema,
  VoidRuleSchema,
  VoidWhenSchema,
} from './connections.ts';

describe('VoidRuleSchema', () => {
  it.each([
    { from: '/status', op: 'in', values: ['canceled', 'incomplete_expired'] },
    { from: '/cancelledAt', op: 'present' },
    { from: '/refunded', op: 'in', values: [true] },
    { from: '/n', op: 'in', values: [0] },
  ])('accepts %j', (rule) => {
    expect(VoidRuleSchema.parse(rule)).toEqual(rule);
  });

  it.each([
    ['in without values', { from: '/a', op: 'in' }],
    ['present with values', { from: '/a', op: 'present', values: ['x'] }],
    ['empty values', { from: '/a', op: 'in', values: [] }],
    ['21 values', { from: '/a', op: 'in', values: Array.from({ length: 21 }, (_, i) => i) }],
    ['object value', { from: '/a', op: 'in', values: [{ a: 1 }] }],
    ['null value', { from: '/a', op: 'in', values: [null] }],
    ['unknown op', { from: '/a', op: 'eq', values: ['x'] }],
    ['empty pointer', { from: '', op: 'present' }],
  ])('rejects %s', (_n, rule) => {
    expect(VoidRuleSchema.safeParse(rule).success).toBe(false);
  });

  it('allows 8 rules and refuses 9', () => {
    const rule = { from: '/a', op: 'present' };
    expect(VoidWhenSchema.safeParse(Array(8).fill(rule)).success).toBe(true);
    expect(VoidWhenSchema.safeParse(Array(9).fill(rule)).success).toBe(false);
  });
});

describe('recipes and overlap', () => {
  it('lists the eight senders', () => {
    expect(RecipeIdSchema.options).toEqual([
      'custom',
      'shopify-orders',
      'shopify-customers',
      'stripe-subscriptions',
      'stripe-payments',
      'calcom-bookings',
      'woocommerce-orders',
      'tickettailor-tickets',
    ]);
  });

  it.each([0, 3600, 86_400, 604_800])('accepts overlap %d', (n) => {
    expect(SecretOverlapSchema.parse(n)).toBe(n);
  });
  it.each([-1, 60, 90_000, '3600'])('rejects overlap %j', (n) => {
    expect(SecretOverlapSchema.safeParse(n).success).toBe(false);
  });

  it('create and update carry voidWhen; update carries overlapSeconds', () => {
    const voidWhen = [{ from: '/status', op: 'in', values: ['canceled'] }];
    const create = CreateConnectionSchema.parse({
      orgId: '01900000-0000-7000-8000-000000000000',
      connectorType: 'webhook-push',
      name: 'n',
      config: {},
      voidWhen,
    });
    expect(create.voidWhen).toEqual(voidWhen);
    expect(UpdateConnectionSchema.parse({ voidWhen, overlapSeconds: 3600 })).toEqual({
      voidWhen,
      overlapSeconds: 3600,
    });
  });

  it('connector info defaults recipes to none', () => {
    const info = ConnectorInfoSchema.parse({
      type: 'x',
      version: 1,
      displayName: 'X',
      capabilities: { poll: false, delta: false, webhook: true, import: false, snapshot: false },
      configSchema: {},
      secretSchema: null,
      outputFields: {},
      defaults: { intervalSeconds: 1, maxConcurrency: 1, requestsPerMinute: 1, timeoutMs: 1 },
      entitled: true,
    });
    expect(info.recipes).toEqual([]);
    expect(info).toMatchObject({ category: 'apis', order: 0 });
    expect(info.capabilities.upload).toBe(false);
  });

  it('takes a draft file id on create only', () => {
    const fileId = '01900000-0000-7000-8000-00000000f11e';
    const create = CreateConnectionSchema.parse({
      orgId: '01900000-0000-7000-8000-000000000000',
      connectorType: 'file-upload',
      name: 'Members',
      config: { idColumn: '/Member ID' },
      fileId,
    });
    expect(create.fileId).toBe(fileId);
    expect(UpdateConnectionSchema.parse({ fileId })).toEqual({});
  });
});
