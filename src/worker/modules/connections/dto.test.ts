import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectorInfoSchema } from '../../../shared/contracts/connections.ts';
import csvUrl from '../../connectors/csv-url/index.ts';
import demo from '../../connectors/demo/index.ts';
import httpJson from '../../connectors/http-json/index.ts';
import webhookPush from '../../connectors/webhook-push/index.ts';
import { connectorInfo, toDto } from './dto.ts';
import { getConnection } from './repo.ts';
import * as service from './service.ts';
import { type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

/** A webhook-push config as version 1 stored it: pointers and headers, no recipe. */
const V1 = {
  recordsPointer: '/items',
  refPointer: '/key',
  recordPointer: '/data',
  deletedPointer: '/gone',
  eventIdPointer: '/event',
  signatureHeader: 'x-acme-signature',
  timestampHeader: 'x-acme-timestamp',
};

async function webhookRow() {
  const created = await service.create(kit.sctx, kit.actor, {
    orgId: kit.org.id,
    connectorType: 'webhook-push',
    name: 'Push',
    config: {},
    mode: 'webhook',
  } as Parameters<typeof service.create>[2]);
  const row = await getConnection(kit.env.DB, created.id);
  if (!row) throw new Error('missing connection');
  return row;
}

describe('toDto config', () => {
  it('shows a v1 webhook-push row as v2 config, under version 2', async () => {
    const dto = toDto(kit.env, { ...(await webhookRow()), connectorVersion: 1, config: V1 });
    expect(dto.connectorVersion).toBe(2);
    expect(dto.config).toEqual({
      ...V1,
      recipe: 'custom',
      acceptTestEvents: false,
      passPer: 'order',
    });
    expect(webhookPush.configSchema.safeParse(dto.config).success).toBe(true);
  });

  it('shows a current-version row as stored', async () => {
    const row = await webhookRow();
    const dto = toDto(kit.env, row);
    expect(dto.connectorVersion).toBe(webhookPush.version);
    expect(dto.config).toBe(row.config);
  });

  it('keeps a row that does not migrate as stored, under its stored version', async () => {
    const broken = { ...V1, recordsPointer: 42 };
    const codes: string[] = [];
    const dto = toDto(
      kit.env,
      { ...(await webhookRow()), connectorVersion: 1, config: broken },
      (c) => codes.push(c),
    );
    expect(dto.connectorVersion).toBe(1);
    expect(dto.config).toEqual(broken);
    expect(codes).toEqual(['MIGRATE_FAILED']);
  });

  it('keeps an unknown connector type as stored', async () => {
    const row = { ...(await webhookRow()), connectorType: 'gone', connectorVersion: 1 };
    expect(toDto(kit.env, row)).toMatchObject({ connectorVersion: 1, config: row.config });
  });
});

describe('draft files', () => {
  it('refuses a fileId on a connector that takes no uploads', async () => {
    await expect(
      service.create(kit.sctx, kit.actor, {
        orgId: kit.org.id,
        connectorType: 'demo',
        name: 'Demo',
        config: { count: 1 },
        fileId: kit.sctx.ids.id(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('connectorInfo', () => {
  it('names each built-in connector a picker group and place', () => {
    const placed = [csvUrl, demo, httpJson, webhookPush].map((def) => {
      const info = connectorInfo(def);
      return [info.type, info.category, info.order, info.capabilities.upload];
    });
    expect(placed).toEqual([
      ['csv-url', 'files', 20, false],
      ['demo', 'try', 10, false],
      ['http-json', 'apis', 10, false],
      ['webhook-push', 'apis', 20, false],
    ]);
  });

  it('groups each sender recipe', () => {
    expect(connectorInfo(webhookPush).recipes.map((r) => [r.id, r.category])).toEqual([
      ['shopify-orders', 'commerce'],
      ['shopify-customers', 'commerce'],
      ['stripe-subscriptions', 'commerce'],
      ['stripe-payments', 'commerce'],
      ['calcom-bookings', 'bookings'],
      ['woocommerce-orders', 'commerce'],
      ['tickettailor-tickets', 'bookings'],
    ]);
  });

  it('fits the contract it is served under', () => {
    for (const def of [csvUrl, demo, httpJson, webhookPush]) {
      expect(ConnectorInfoSchema.safeParse(connectorInfo(def)).success).toBe(true);
    }
  });
});
