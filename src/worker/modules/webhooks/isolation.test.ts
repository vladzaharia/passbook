import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { countOf, deliveriesOf, feedOf, seedEndpoint } from './webhooks-test-fixtures.ts';

let kit: ScanKit;
let orgA: string;
let orgB: string;
const db = () => kit.env.DB;

const aborts = async (sql: string, params: (string | number | null)[] = []) =>
  run(db(), sql, params).then(
    () => null,
    (e: Error) => String(e.message),
  );

beforeAll(async () => {
  kit = await setupScanKit();
  orgA = kit.org.id;
  orgB = (await makeOrg(kit.fx)).id;
});

describe('proof 1: a wrong-tenant delivery cannot exist as a row', () => {
  const FK = /FOREIGN KEY constraint failed/;
  const insertDelivery = `INSERT INTO webhook_deliveries (endpoint_id, event_seq, org_id, mode) VALUES (?, ?, ?, ?)`;

  it('refuses a raw delivery joining one org endpoint to another org feed row', async () => {
    const passB = await kit.pass({ orgId: orgB });
    const [feedB] = await feedOf(db(), passB.id);
    expect(feedB).toBeDefined();
    const seq = feedB?.seq as number;
    const epA = await seedEndpoint(db(), { orgId: orgA });
    // Named for org A: the feed row is B's. Named for org B: the endpoint is A's.
    expect(await aborts(insertDelivery, [epA, seq, orgA, 'live'])).toMatch(FK);
    expect(await aborts(insertDelivery, [epA, seq, orgB, 'live'])).toMatch(FK);
    expect(await deliveriesOf(db(), epA)).toEqual([]);
    // Positive control: the same insert with B's own endpoint and B's feed row is accepted.
    const epB = await seedEndpoint(db(), { orgId: orgB, eventTypes: ['pass.voided'] });
    expect(await aborts(insertDelivery, [epB, seq, orgB, 'live'])).toBeNull();
    expect((await deliveriesOf(db(), epB)).map((d) => d.event_seq)).toEqual([seq]);
  });

  it('refuses cross-tenant secrets and attempts, and accepts the consistent ones', async () => {
    const epA = await seedEndpoint(db(), { orgId: orgA });
    const passB = await kit.pass({ orgId: orgB });
    const [feedB] = await feedOf(db(), passB.id);
    const secret = (id: string, org: string) =>
      aborts(
        `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek,
           ciphertext, created_at) VALUES (?, ?, ?, 'live', 1, x'00', x'00', x'00', 1)`,
        [id, epA, org],
      );
    expect(await secret('x-b', orgB)).toMatch(FK);
    expect(await secret('x-a', orgA)).toBeNull();
    const attempt = (id: string, endpoint: string, org: string, seq: number | null) =>
      aborts(
        `INSERT INTO webhook_attempts (id, endpoint_id, org_id, mode, event_seq, attempt, trigger,
           duration_ms, at) VALUES (?, ?, ?, 'live', ?, 1, 'event', 1, 1)`,
        [id, endpoint, org, seq],
      );
    expect(await attempt('t1', epA, orgB, null)).toMatch(FK);
    expect(await attempt('t2', epA, orgA, feedB?.seq ?? null)).toMatch(FK);
    expect(await attempt('t3', epA, orgA, null)).toBeNull();
    // An attempt's key cannot be re-pointed at another tenant's consistent triple.
    const epB = await seedEndpoint(db(), { orgId: orgB, eventTypes: ['pass.voided'] });
    expect(await aborts(insertDelivery, [epB, feedB?.seq ?? 0, orgB, 'live'])).toBeNull();
    expect(await attempt('t4', epB, orgB, feedB?.seq ?? null)).toBeNull();
    for (const [column, value] of [
      ['endpoint_id', epB],
      ['org_id', orgB],
      ['event_seq', feedB?.seq ?? 0],
      ['mode', 'test'],
    ] as const)
      expect(
        await aborts(`UPDATE webhook_attempts SET ${column} = ? WHERE id = 't3'`, [value]),
      ).toMatch(/immutable webhook attempt key/);
  });

  it('refuses a feed row whose tenant is not its pass tenant, however it is written', async () => {
    const pass = await kit.pass();
    const insert = (org: string, mode: string) =>
      aborts(
        `INSERT INTO event_feed (event_id, org_id, mode, pass_id, template_id, type, kind, data, at)
         VALUES (?, ?, ?, ?, 't', 'pass.voided', 'pass.voided', '{}', 1)`,
        [`forged-${org}-${mode}`, org, mode, pass.id],
      );
    expect(await insert(orgB, 'live')).toMatch(/event feed tenant/);
    expect(await insert(orgA, 'test')).toMatch(/event feed tenant/);
    expect(await insert(orgA, 'live')).toBeNull();
  });

  it('refuses mixing modes', async () => {
    const pass = await kit.pass();
    const [feed] = await feedOf(db(), pass.id);
    const testEndpoint = await seedEndpoint(db(), { orgId: orgA, mode: 'test' });
    for (const mode of ['live', 'test'])
      expect(await aborts(insertDelivery, [testEndpoint, feed?.seq ?? 0, orgA, mode])).toMatch(FK);
  });

  it('aborts an update of any delivery key', async () => {
    const ep = await seedEndpoint(db(), { orgId: orgA });
    const pass = await kit.pass();
    expect((await deliveriesOf(db(), ep)).length).toBe(1);
    for (const [column, value] of [
      ['org_id', orgB],
      ['mode', 'test'],
      ['endpoint_id', 'other'],
      ['event_seq', 999999],
    ] as const)
      expect(
        await aborts(`UPDATE webhook_deliveries SET ${column} = ? WHERE endpoint_id = ?`, [
          value,
          ep,
        ]),
      ).toMatch(/immutable webhook delivery key/);
    expect(pass.id).toBeTruthy();
  });

  it('aborts an update of an endpoint identity', async () => {
    const ep = await seedEndpoint(db(), { orgId: orgA });
    for (const [column, value] of [
      ['id', 'x'],
      ['org_id', orgB],
      ['mode', 'test'],
      ['created_at', 2],
    ] as const)
      expect(
        await aborts(`UPDATE webhook_endpoints SET ${column} = ? WHERE id = ?`, [value, ep]),
      ).toMatch(/immutable webhook endpoint identity/);
  });
});

describe('proof 3: a mismatched ledger row produces nothing', () => {
  it('writes no feed row or delivery when the ledger names another org for the pass', async () => {
    const epB = await seedEndpoint(db(), { orgId: orgB, eventTypes: ['pass.voided'] });
    const epA = await seedEndpoint(db(), { orgId: orgA, eventTypes: ['pass.voided'] });
    const pass = await kit.pass();
    const feed = await countOf(db(), 'event_feed');
    const deliveries = await countOf(db(), 'webhook_deliveries');
    // Forced by raw SQL: the ordinary writers fence this themselves.
    await run(
      db(),
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
       VALUES ('forged-1', ?, ?, 'live', 'pass.voided', '{}', 1)`,
      [orgB, pass.id],
    );
    expect(await countOf(db(), 'pass_events', "id = 'forged-1'")).toBe(1);
    expect(await countOf(db(), 'event_feed')).toBe(feed);
    expect(await countOf(db(), 'webhook_deliveries')).toBe(deliveries);
    expect(await deliveriesOf(db(), epA)).toEqual([]);
    expect(await deliveriesOf(db(), epB)).toEqual([]);
  });

  it('writes none when the ledger mode differs from the pass mode', async () => {
    const pass = await kit.pass();
    const feed = await countOf(db(), 'event_feed');
    await run(
      db(),
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
       VALUES ('forged-2', ?, ?, 'test', 'pass.voided', '{}', 1)`,
      [orgA, pass.id],
    );
    expect(await countOf(db(), 'event_feed')).toBe(feed);
  });
});

describe('proof 4: test rows on live passes produce nothing', () => {
  it('through the ledger writer, and no test endpoint receives a live pass event', async () => {
    const testEndpoint = await seedEndpoint(db(), {
      orgId: orgA,
      mode: 'test',
      eventTypes: ['pass.voided'],
    });
    const pass = await kit.pass();
    const feed = await countOf(db(), 'event_feed');
    await recordPassEvent(kit.ctx, {
      orgId: orgA,
      passId: pass.id,
      mode: 'test',
      kind: 'pass.voided',
    });
    // The test ledger row was written; only the journal ignored it.
    expect(await countOf(db(), 'pass_events', `pass_id = '${pass.id}' AND mode = 'test'`)).toBe(1);
    expect(await countOf(db(), 'event_feed')).toBe(feed);
    await recordPassEvent(kit.ctx, {
      orgId: orgA,
      passId: pass.id,
      mode: 'live',
      kind: 'pass.voided',
    });
    expect(await countOf(db(), 'event_feed')).toBe(feed + 1);
    expect(await deliveriesOf(db(), testEndpoint)).toEqual([]);
  });

  it('a test pass event reaches a test endpoint only', async () => {
    const live = await seedEndpoint(db(), { orgId: orgA, eventTypes: ['pass.issued'] });
    const test = await seedEndpoint(db(), {
      orgId: orgA,
      mode: 'test',
      eventTypes: ['pass.issued'],
    });
    const pass = await kit.pass({ mode: 'test' });
    const [row] = await feedOf(db(), pass.id);
    expect(row).toMatchObject({ mode: 'test', type: 'pass.issued' });
    expect((await deliveriesOf(db(), test)).map((d) => d.mode)).toEqual(['test']);
    expect(await deliveriesOf(db(), live)).toEqual([]);
  });
});

describe('limits and immutability', () => {
  it('aborts the 101st endpoint of an org and mode, and counts modes apart', async () => {
    const org = (await makeOrg(kit.fx)).id;
    for (let i = 0; i < 100; i++) await seedEndpoint(db(), { orgId: org });
    await expect(seedEndpoint(db(), { orgId: org })).rejects.toThrow(/webhook endpoint limit/);
    await expect(seedEndpoint(db(), { orgId: org, mode: 'test' })).resolves.toBeTruthy();
  });

  it('refuses updates to the feed', async () => {
    const pass = await kit.pass();
    expect(await aborts("UPDATE event_feed SET type = 'x' WHERE pass_id = ?", [pass.id])).toMatch(
      /append-only event feed/,
    );
  });

  it('refuses a secret ciphertext or identity change, allows only an earlier expiry', async () => {
    const ep = await seedEndpoint(db(), { orgId: orgA });
    await run(
      db(),
      `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek,
         ciphertext, created_at, expires_at) VALUES ('s1', ?, ?, 'live', 1, x'00', x'00', x'00', 1, 100)`,
      [ep, orgA],
    );
    for (const set of ["ciphertext = x'01'", "iv = x'01'", "mode = 'test'", 'created_at = 2'])
      expect(await aborts(`UPDATE webhook_endpoint_secrets SET ${set} WHERE id = 's1'`)).toMatch(
        /immutable webhook secret/,
      );
    expect(
      await aborts("UPDATE webhook_endpoint_secrets SET expires_at = 200 WHERE id = 's1'"),
    ).toMatch(/immutable webhook secret/);
    expect(
      await aborts("UPDATE webhook_endpoint_secrets SET expires_at = 50 WHERE id = 's1'"),
    ).toBeNull();
    expect(
      await aborts("UPDATE webhook_endpoint_secrets SET kek_version = 2 WHERE id = 's1'"),
    ).toBeNull();
    // An expired secret cannot be revived.
    expect(
      await aborts("UPDATE webhook_endpoint_secrets SET expires_at = NULL WHERE id = 's1'"),
    ).toMatch(/immutable webhook secret/);
  });

  it('allows one current secret per endpoint', async () => {
    const ep = await seedEndpoint(db(), { orgId: orgA });
    const insert = `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek,
         ciphertext, created_at) VALUES (?, ?, ?, 'live', 1, x'00', x'00', x'00', 1)`;
    expect(await aborts(insert, ['c1', ep, orgA])).toBeNull();
    expect(await aborts(insert, ['c2', ep, orgA])).toMatch(/UNIQUE/);
  });

  it('cascades an endpoint delete to its deliveries and secrets', async () => {
    const ep = await seedEndpoint(db(), { orgId: orgA });
    await kit.pass();
    expect((await deliveriesOf(db(), ep)).length).toBe(1);
    await run(db(), 'DELETE FROM webhook_endpoints WHERE id = ?', [ep]);
    expect(await deliveriesOf(db(), ep)).toEqual([]);
  });
});
