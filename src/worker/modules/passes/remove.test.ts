import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { PassDevicesSchema, PassSummarySchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import { handlePushDeliver } from '../delivery/jobs.ts';
import { applyRemoval } from './remove-build.ts';
import { currentPassJson, getPass, type Pass } from './repo.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const post = (path: string, body?: unknown, headers: Record<string, string> = fake.admin()) =>
  app.request(
    `${ORIGIN}/api/v1/passes${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    kit.env,
  );
const json = async (pass: Pass) =>
  JSON.parse((await currentPassJson(kit.env.DB, pass.id)) ?? '{}') as Record<string, unknown>;

describe('applyRemoval', () => {
  it('voids, expires now and strips everything that surfaces or scans', () => {
    const pass = {
      generic: { primaryFields: [], backFields: [{ key: 'terms', value: 'x' }] },
      barcodes: [{ message: 'a' }],
      barcode: { message: 'a' },
      locations: [{ latitude: 1, longitude: 2 }],
      beacons: [{ proximityUUID: 'u' }],
      relevantDate: 'x',
      relevantDates: [{}],
      featuredActions: [],
      nfc: { message: 'm' },
    } as unknown as PassJson;
    applyRemoval(pass, { at: Date.UTC(2026, 10, 4), message: 'Moved to the new app' });
    const out = pass as Record<string, unknown>;
    for (const key of [
      'barcode',
      'barcodes',
      'locations',
      'beacons',
      'relevantDate',
      'relevantDates',
      'featuredActions',
      'nfc',
    ])
      expect(out[key]).toBeUndefined();
    expect(out).toMatchObject({ voided: true, expirationDate: '2026-11-04T00:00:00.000Z' });
    const back = (out.generic as { backFields: { key: string; changeMessage?: string }[] })
      .backFields;
    expect(back.map((f) => f.key)).toEqual(['terms', 'passbook_removed']);
    expect(back[1]).toMatchObject({ value: 'Moved to the new app', changeMessage: '%@' });
  });

  it('adds no field without a message', () => {
    const pass = { generic: { backFields: [] } } as unknown as PassJson;
    applyRemoval(pass, { at: 0, message: null });
    expect((pass as { generic: { backFields: unknown[] } }).generic.backFields).toEqual([]);
  });
});

describe('POST /passes/{id}/remove and /restore', () => {
  it('publishes the stripped final version, pushes it and restores it', async () => {
    const pass = await kit.pass();
    for (const d of ['rm-a', 'rm-b'])
      await app.request(
        `${ORIGIN}/wallet/v1/devices/${d}/registrations/${TYPE}/${pass.serial}`,
        {
          method: 'POST',
          headers: {
            authorization: `ApplePass ${pass.authToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ pushToken: 'c'.repeat(64) }),
        },
        kit.env,
      );
    const original = await json(pass);
    kit.clock.advance(5000);
    const res = await post(`/${pass.id}/remove`, { message: 'Your pass was replaced' });
    expect(res.status).toBe(200);
    const summary = PassSummarySchema.parse(await res.json());
    expect(summary).toMatchObject({ status: 'voided', version: 2 });
    expect(summary.removedAt).not.toBeNull();

    const final = await json(pass);
    expect(final).toMatchObject({ voided: true });
    expect(final.barcodes).toBeUndefined();
    expect(typeof final.expirationDate).toBe('string');
    const version = await first<{ source: string | null }>(
      kit.env.DB,
      'SELECT source FROM pass_versions WHERE pass_id = ? AND version = 2',
      [pass.id],
    );
    expect(version?.source).toBe('remove');
    const kinds = (
      await all<{ kind: string }>(
        kit.env.DB,
        'SELECT kind FROM pass_events WHERE pass_id = ? ORDER BY at, id',
        [pass.id],
      )
    ).map((r) => r.kind);
    expect(kinds).toContain('pass.removed');

    // Removing again changes nothing.
    expect(PassSummarySchema.parse(await (await post(`/${pass.id}/remove`)).json()).version).toBe(
      2,
    );

    // Progress: pending until a device fetches the removal version.
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC, id DESC LIMIT 1",
      [pass.id],
    );
    await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
    const progress = async () =>
      PassDevicesSchema.parse(
        await (
          await app.request(
            `${ORIGIN}/api/v1/passes/${pass.id}/devices`,
            { headers: fake.admin() },
            kit.env,
          )
        ).json(),
      );
    expect((await progress()).removal).toMatchObject({ total: 2, done: 0, version: 2 });
    kit.clock.advance(1000);
    for (const d of ['rm-a'])
      await app.request(`${ORIGIN}/wallet/v1/devices/${d}/registrations/${TYPE}`, {}, kit.env);
    await app.request(
      `${ORIGIN}/wallet/v1/passes/${TYPE}/${pass.serial}`,
      { headers: { authorization: `ApplePass ${pass.authToken}` } },
      kit.env,
    );
    const after = await progress();
    expect(after.removal).toMatchObject({ total: 2, done: 1 });
    expect(after.devices.map((d) => d.removal).sort()).toEqual(['fetched', 'pending']);

    kit.clock.advance(1000);
    const restored = PassSummarySchema.parse(await (await post(`/${pass.id}/restore`)).json());
    expect(restored).toMatchObject({ status: 'active', removedAt: null, version: 3 });
    const back = await json(pass);
    expect(back.voided).toBeUndefined();
    expect(back).toEqual(original);
    expect((await getPass(kit.env.DB, pass.id))?.removedAt).toBeNull();
  });

  it('keeps a removed pass removed through later publishes, and restores a voided pass as voided', async () => {
    const pass = await kit.pass();
    await post(`/${pass.id}/void`);
    kit.clock.advance(1000);
    await post(`/${pass.id}/remove`);
    const { updatePass } = await import('./service.ts');
    kit.clock.advance(1000);
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Late sync' } },
      { scope: null },
    );
    expect(await json(pass)).toMatchObject({ voided: true });
    expect((await json(pass)).barcodes).toBeUndefined();
    kit.clock.advance(1000);
    expect(PassSummarySchema.parse(await (await post(`/${pass.id}/restore`)).json()).status).toBe(
      'voided',
    );
  });

  it('refuses void and unvoid on a removed pass, and skips it in a bulk void', async () => {
    const pass = await kit.pass();
    await post(`/${pass.id}/remove`);
    for (const action of ['void', 'unvoid']) {
      const res = await post(`/${pass.id}/${action}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PASS_REMOVED' });
    }
    const bulk = await (await post('/bulk', { action: 'void', ids: [pass.id] })).json();
    expect(bulk).toMatchObject({ done: 0, skipped: [{ id: pass.id, code: 'PASS_REMOVED' }] });
  });

  it('removes once when two removes race', async () => {
    const pass = await kit.pass();
    const [a, b] = await Promise.all([post(`/${pass.id}/remove`), post(`/${pass.id}/remove`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const row = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'pass.removed'",
      [pass.id],
    );
    expect(row?.n).toBe(1);
  });

  it('needs passes:write, stays inside the key org and works in either mode', async () => {
    const pass = await kit.pass();
    const other = await makeOrg(kit.fx, { name: 'Elsewhere' });
    expect((await post(`/${pass.id}/remove`, {}, {})).status).toBe(401);
    expect((await post(`/${pass.id}/remove`, {}, fake.user())).status).toBe(403);
    expect(
      (
        await post(
          `/${pass.id}/remove`,
          {},
          fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] }),
        )
      ).status,
    ).toBe(403);
    expect((await post(`/${pass.id}/remove`, {}, fake.apiKey({ orgId: other.id }))).status).toBe(
      404,
    );
    expect((await post(`/${pass.id}/restore`, {}, fake.apiKey({ orgId: other.id }))).status).toBe(
      404,
    );
    expect((await post(`/${pass.id}/remove`, { message: 'x'.repeat(201) })).status).toBe(422);
    // A session changes only the mode it is in.
    expect((await post(`/${pass.id}/remove`, {}, fake.admin({ mode: 'test' }))).status).toBe(409);
    expect((await post(`/${pass.id}/remove`, {}, fake.apiKey({ mode: 'test' }))).status).toBe(404);
  });

  it('removes a selection in bulk and 404s the whole call for a foreign id', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const res = await post('/bulk', { action: 'remove', ids: [a.id, b.id], message: 'Bye' });
    expect(await res.json()).toEqual({ done: 2, skipped: [] });
    expect((await getPass(kit.env.DB, a.id))?.removedAt).not.toBeNull();
    const other = await makeOrg(kit.fx, { name: 'Else' });
    const c = await kit.pass();
    expect(
      (await post('/bulk', { action: 'remove', ids: [c.id] }, fake.apiKey({ orgId: other.id })))
        .status,
    ).toBe(404);
    expect((await getPass(kit.env.DB, c.id))?.removedAt).toBeNull();
  });
});
