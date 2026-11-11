import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { create as createConnection } from '../connections/service.ts';
import { reassignHolder } from '../holders/service.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import {
  EMAIL_ORG_DAILY_CAP,
  EMAIL_RECIPIENT_HOURLY_CAP,
  enqueuePassEmail,
} from './issuance-intent.ts';
import { getOutbox } from './repo.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const HOUR = 3_600_000;
const DAY = 86_400_000;

async function update(sql: string, params: SqlValue[]) {
  // meta.changes also counts trigger-owned epoch writes, so count the statement's own rows.
  expect(await all(kit.env.DB, `${sql} RETURNING 1`, params)).toHaveLength(1);
}

async function connection(orgId: string) {
  return createConnection(job(), { type: 'system', id: null }, {
    orgId,
    connectorType: 'demo',
    name: 'Email fence',
    config: { count: 1 },
    mode: 'manual',
  } as never);
}

async function bound(externalRef: string | null = 'm-001') {
  const org = await makeOrg(kit.fx);
  const release = await approveAppleRelease(kit, { orgId: org.id });
  const original = await connection(org.id);
  const replacement = await connection(org.id);
  const to = `${kit.ctx.ids.id()}@example.com`;
  const created = await kit.pass({ orgId: org.id, holderEmail: to });
  await update('UPDATE connections SET generation = ? WHERE id = ?', [7, original.id]);
  await update('UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    original.id,
    externalRef,
    created.id,
  ]);
  const pass = await getPass(kit.env.DB, created.id);
  if (!pass) throw new Error('bound pass missing');
  const pin = await first<{ release_id: string | null }>(
    kit.env.DB,
    'SELECT release_id FROM passes WHERE id = ?',
    [pass.id],
  );
  expect(pin?.release_id).toBe(release.id);
  return {
    org,
    pass,
    to,
    release,
    replacement,
    connection: { orgId: org.id, connectionId: original.id, externalRef, generation: 7 },
  };
}

interface Bound {
  org: { id: string };
  pass: { id: string };
  replacement: { id: string };
  connection: { connectionId: string };
}

/** Intervene once outside the real first transaction and record its prepared SQL. */
function atInsert(passId: string, intervene?: () => Promise<void>) {
  let prefetched = false;
  let captured: { prefetched: boolean; sql: string[] } | null = null;
  let scheduled = 0;
  const statements = new WeakMap<
    D1PreparedStatement,
    { target: D1PreparedStatement; sql: string }
  >();
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(statement.bind(...values), sql);
        if (prop === 'first')
          return async (...args: unknown[]) => {
            const firstMethod = Reflect.get(statement, prop, statement) as (
              ...values: unknown[]
            ) => Promise<unknown>;
            const result = await firstMethod.apply(statement, args);
            if (
              /\bFROM\s+passes\b/i.test(sql) &&
              result &&
              typeof result === 'object' &&
              'id' in result &&
              result.id === passId
            )
              prefetched = true;
            return result;
          };
        const value = Reflect.get(statement, prop, statement);
        return typeof value === 'function' ? value.bind(statement) : value;
      },
    });
    statements.set(proxy, { target, sql });
    return proxy;
  };
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (!captured) {
            captured = {
              prefetched,
              sql: batch.map((statement) => statements.get(statement)?.sql ?? ''),
            };
            if (intervene) await intervene();
          }
          return target.batch(
            batch.map((statement) => statements.get(statement)?.target ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return {
    ctx: {
      ...job(),
      env,
      waitUntil: (promise: Promise<unknown>) => {
        scheduled++;
        kit.ctx.waitUntil(promise);
      },
    },
    capture: () => captured,
    scheduled: () => scheduled,
  };
}

function expectInsertSeam(seam: { capture: () => { prefetched: boolean; sql: string[] } | null }) {
  const capture = seam.capture();
  expect(capture?.prefetched).toBe(true);
  expect(capture?.sql.join('\n')).toMatch(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+outbox\b/i);
}

async function effects(passId: string) {
  await kit.settle();
  return {
    outbox: await all<{ kind: string }>(
      kit.env.DB,
      'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id',
      [passId],
    ),
    events: await all<{ kind: string }>(
      kit.env.DB,
      'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id',
      [passId],
    ),
    counters: await all(
      kit.env.DB,
      "SELECT * FROM counters WHERE key LIKE 'pass-email:%' ORDER BY key, window_start",
    ),
    queue: [...kit.queue.sent],
  };
}

async function counters(orgId: string, to: string, mode: 'live' | 'test' = 'live') {
  const hash = (await sha256Hex(`pass-email:${to.toLowerCase()}`)).slice(0, 32);
  return all<{ key: string; window_start: number; count: number }>(
    kit.env.DB,
    'SELECT key, window_start, count FROM counters WHERE key IN (?, ?) ORDER BY key, window_start',
    [`pass-email:${mode}:org:${orgId}`, `pass-email:${mode}:to:${hash}`],
  );
}

const races = [
  [
    'the pass is reassigned to another connection',
    (f: Bound) =>
      update('UPDATE passes SET connection_id = ? WHERE id = ?', [f.replacement.id, f.pass.id]),
  ],
  [
    'the external reference changes',
    (f: Bound) => update("UPDATE passes SET external_ref = 'm-002' WHERE id = ?", [f.pass.id]),
  ],
  [
    'the connection is disabled',
    (f: Bound) =>
      update('UPDATE connections SET enabled = 0 WHERE id = ?', [f.connection.connectionId]),
  ],
  [
    'the connection generation advances',
    (f: Bound) =>
      update('UPDATE connections SET generation = generation + 1 WHERE id = ?', [
        f.connection.connectionId,
      ]),
  ],
  [
    'the lifecycle changes and returns to active',
    async (f: Bound) => {
      await update("UPDATE passes SET status = 'voided' WHERE id = ?", [f.pass.id]);
      await update("UPDATE passes SET status = 'active' WHERE id = ?", [f.pass.id]);
    },
  ],
  [
    'the link generation changes',
    (f: Bound) =>
      update('UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [f.pass.id]),
  ],
  [
    'the connection moves to another tenant',
    (f: Bound) =>
      update('UPDATE connections SET org_id = ? WHERE id = ?', [
        kit.org.id,
        f.connection.connectionId,
      ]),
  ],
] as const;

describe('connection pass email enqueue fence', () => {
  it.each([
    ['the pass version', 'UPDATE passes SET version = version + 1 WHERE id = ?'],
    ['the download token', "UPDATE passes SET download_token = 'rotated-' || id WHERE id = ?"],
  ])(
    'still queues when %s changes after prefetch (content, not authority)',
    async (_label, sql) => {
      const f = await bound();
      const seam = atInsert(f.pass.id, () => update(sql, [f.pass.id]));
      await expect(
        enqueuePassEmail(seam.ctx, {
          passId: f.pass.id,
          to: f.to,
          attach: true,
          expected: f.pass,
          connection: f.connection,
          release: f.release,
        }),
      ).resolves.toHaveProperty('outboxId');
      expectInsertSeam(seam);
    },
  );

  it('refuses with a plain 403 when the organization is suspended after prefetch', async () => {
    const f = await bound();
    const before = await effects(f.pass.id);
    const seam = atInsert(f.pass.id, () =>
      update("UPDATE orgs SET status = 'suspended' WHERE id = ?", [f.org.id]),
    );
    await expect(
      enqueuePassEmail(seam.ctx, {
        passId: f.pass.id,
        to: f.to,
        attach: true,
        expected: f.pass,
        connection: f.connection,
        release: f.release,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(seam.scheduled()).toBe(0);
    expect(await effects(f.pass.id)).toEqual(before);
  });

  it.each(races)(
    'leaves no delivery side effects when %s after prefetch',
    async (_label, mutate) => {
      const f = await bound();
      const before = await effects(f.pass.id);
      const seam = atInsert(f.pass.id, () => mutate(f));
      await expect(
        enqueuePassEmail(seam.ctx, {
          passId: f.pass.id,
          to: f.to,
          attach: true,
          expected: f.pass,
          connection: f.connection,
          release: f.release,
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
      expectInsertSeam(seam);
      expect(seam.scheduled()).toBe(0);
      expect(await effects(f.pass.id)).toEqual(before);
    },
  );

  it('rejects a real completed holder transfer after the recipient snapshot', async () => {
    const f = await bound();
    const before = await effects(f.pass.id);
    const seam = atInsert(f.pass.id, async () => {
      await reassignHolder(
        jobCtxOf(kit),
        { type: 'system', id: null },
        { passId: f.pass.id, email: 'replacement@example.com' },
        null,
      );
      expect(
        await first(
          kit.env.DB,
          "SELECT state FROM pass_credential_transfers WHERE pass_id = ? AND state = 'completed'",
          [f.pass.id],
        ),
      ).toEqual({ state: 'completed' });
    });
    await expect(
      enqueuePassEmail(seam.ctx, {
        passId: f.pass.id,
        to: f.to,
        attach: true,
        expected: f.pass,
        connection: f.connection,
        release: f.release,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
    expectInsertSeam(seam);
    expect(seam.scheduled()).toBe(0);
    const after = await effects(f.pass.id);
    expect(after.outbox.filter((row) => row.kind === 'email')).toEqual(
      before.outbox.filter((row) => row.kind === 'email'),
    );
    expect(after.counters).toEqual(before.counters);
    expect(
      after.queue.filter(
        (job) =>
          typeof job === 'object' && job !== null && 'kind' in job && job.kind === 'email.send',
      ),
    ).toEqual(
      before.queue.filter(
        (job) =>
          typeof job === 'object' && job !== null && 'kind' in job && job.kind === 'email.send',
      ),
    );
    expect(after.events.filter((event) => event.kind.startsWith('email.'))).toEqual(
      before.events.filter((event) => event.kind.startsWith('email.')),
    );
  });

  it('fences a null external reference if one is assigned after prefetch', async () => {
    const f = await bound(null);
    const before = await effects(f.pass.id);
    const seam = atInsert(f.pass.id, () =>
      update("UPDATE passes SET external_ref = 'm-001' WHERE id = ?", [f.pass.id]),
    );
    await expect(
      enqueuePassEmail(seam.ctx, {
        passId: f.pass.id,
        to: f.to,
        attach: false,
        expected: f.pass,
        connection: f.connection,
        release: f.release,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
    expectInsertSeam(seam);
    expect(seam.scheduled()).toBe(0);
    expect(await effects(f.pass.id)).toEqual(before);
  });

  it.each(['m-001', null])('queues once for unchanged authority and reference %s', async (ref) => {
    const f = await bound(ref);
    const before = await effects(f.pass.id);
    expect(await counters(f.org.id, f.to)).toEqual([]);
    const seam = atInsert(f.pass.id);
    const { outboxId } = await enqueuePassEmail(seam.ctx, {
      passId: f.pass.id,
      to: f.to.toUpperCase(),
      attach: true,
      expected: f.pass,
      connection: f.connection,
      release: f.release,
    });
    expectInsertSeam(seam);
    await kit.settle();
    expect(seam.scheduled()).toBe(1);
    expect(kit.queue.sent.slice(before.queue.length)).toEqual([{ kind: 'email.send', outboxId }]);
    const row = await getOutbox(kit.env.DB, outboxId);
    expect(row).toMatchObject({
      id: outboxId,
      orgId: f.org.id,
      passId: f.pass.id,
      kind: 'email',
      state: 'enqueued',
      payload: {
        to: f.to,
        attach: true,
        intent: {
          format: 1,
          to: f.to,
          attach: true,
          pass: {
            passId: f.pass.id,
            orgId: f.org.id,
            mode: 'live',
            testDataQuarantined: false,
            holderEmail: f.pass.holderEmail,
            ownerUserId: f.pass.ownerUserId,
            version: f.pass.version,
            linkGeneration: f.pass.linkGeneration,
            objectKey: f.pass.objectKey,
            downloadTokenHash: await sha256Hex(f.pass.downloadToken),
            status: f.pass.status,
            removedAt: f.pass.removedAt,
          },
        },
      },
    });
    expect(JSON.stringify(row?.payload)).not.toContain(f.pass.downloadToken);
    const queued = await all<{ org_id: string; pass_id: string; mode: string; data: string }>(
      kit.env.DB,
      "SELECT org_id, pass_id, mode, data FROM pass_events WHERE pass_id = ? AND kind = 'email.queued'",
      [f.pass.id],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ org_id: f.org.id, pass_id: f.pass.id, mode: 'live' });
    expect(JSON.parse(queued[0]?.data ?? '{}')).toEqual({ outboxId, attached: true });
    const hash = (await sha256Hex(`pass-email:${f.to}`)).slice(0, 32);
    const now = kit.clock.now();
    expect(await counters(f.org.id, f.to)).toEqual([
      { key: `pass-email:live:org:${f.org.id}`, window_start: now - (now % DAY), count: 1 },
      { key: `pass-email:live:to:${hash}`, window_start: now - (now % HOUR), count: 1 },
    ]);
  });

  it('rejects wrong connection authority without side effects', async () => {
    const f = await bound();
    const before = await effects(f.pass.id);
    const contexts = [
      { ...f.connection, orgId: kit.org.id },
      { ...f.connection, connectionId: f.replacement.id },
      { ...f.connection, externalRef: 'm-002' },
      { ...f.connection, externalRef: null },
      { ...f.connection, generation: f.connection.generation + 1 },
    ];
    for (const connection of contexts) {
      const seam = atInsert(f.pass.id);
      await expect(
        enqueuePassEmail(seam.ctx, {
          passId: f.pass.id,
          to: f.to,
          attach: false,
          expected: f.pass,
          connection,
          release: f.release,
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
      expect(seam.scheduled()).toBe(0);
      expect(await effects(f.pass.id)).toEqual(before);
    }
  });

  it.each([true, false])(
    'keeps a superseded issued release valid and ignores a changed pin (connection: %s)',
    async (connected) => {
      const f = await bound();
      const newer = await approveAppleRelease(kit, { orgId: f.org.id });
      expect(newer.id).not.toBe(f.release.id);
      const context = connected ? { connection: f.connection } : {};
      const before = await effects(f.pass.id);
      const seam = atInsert(f.pass.id);
      const input = {
        passId: f.pass.id,
        to: f.to,
        attach: false,
        expected: f.pass,
        release: f.release,
        ...context,
      };
      const { outboxId } = await enqueuePassEmail(seam.ctx, input);
      expectInsertSeam(seam);
      await kit.settle();
      expect(kit.queue.sent.slice(before.queue.length)).toEqual([{ kind: 'email.send', outboxId }]);
      // The pin is a release fact, checked at create and publish only: a re-pinned pass still mails.
      const raced = atInsert(f.pass.id, () =>
        update('UPDATE passes SET release_id = ? WHERE id = ?', [newer.id, f.pass.id]),
      );
      await expect(enqueuePassEmail(raced.ctx, input)).resolves.toHaveProperty('outboxId');
      expectInsertSeam(raced);
    },
  );

  it('rejects a connection on a matching Test-mode pass and release', async () => {
    const f = await bound();
    const release = await approveAppleRelease(kit, { orgId: f.org.id, mode: 'test' });
    const created = await kit.pass({ orgId: f.org.id, mode: 'test', holderEmail: f.to });
    // A connection reference belongs to one pass in any mode, so the Test pass takes its own.
    const connection = { ...f.connection, externalRef: 'm-test' };
    await update('UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connection.connectionId,
      connection.externalRef,
      created.id,
    ]);
    const pass = await getPass(kit.env.DB, created.id);
    if (!pass) throw new Error('test pass missing');
    const before = await effects(pass.id);
    const seam = atInsert(pass.id);
    await expect(
      enqueuePassEmail(seam.ctx, {
        passId: pass.id,
        to: f.to,
        attach: false,
        expected: pass,
        connection,
        release,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
    expect(seam.scheduled()).toBe(0);
    expect(await effects(pass.id)).toEqual(before);
  });

  it.each(['recipient', 'organization'] as const)(
    'leaves no side effects when the %s is capped',
    async (cap) => {
      const f = await bound();
      if (cap === 'recipient') {
        for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++) {
          await enqueuePassEmail(job(), {
            passId: f.pass.id,
            to: f.to,
            attach: false,
            expected: f.pass,
            connection: f.connection,
            release: f.release,
          });
        }
      } else {
        const now = kit.clock.now();
        await update('INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)', [
          `pass-email:live:org:${f.org.id}`,
          now - (now % DAY),
          EMAIL_ORG_DAILY_CAP,
        ]);
      }
      const before = await effects(f.pass.id);
      expect((await counters(f.org.id, f.to)).map((row) => row.count)).toEqual(
        cap === 'recipient'
          ? [EMAIL_RECIPIENT_HOURLY_CAP, EMAIL_RECIPIENT_HOURLY_CAP]
          : [EMAIL_ORG_DAILY_CAP],
      );
      const seam = atInsert(f.pass.id);
      await expect(
        enqueuePassEmail(seam.ctx, {
          passId: f.pass.id,
          to: f.to.toUpperCase(),
          attach: false,
          expected: f.pass,
          connection: f.connection,
          release: f.release,
        }),
      ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
      expectInsertSeam(seam);
      expect(seam.scheduled()).toBe(0);
      expect(await effects(f.pass.id)).toEqual(before);
    },
  );

  it('preserves an enqueue without connection or release context', async () => {
    const f = await bound();
    const before = await effects(f.pass.id);
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: f.pass.id,
      to: f.to,
      attach: false,
      expected: f.pass,
    });
    await kit.settle();
    expect(kit.queue.sent.slice(before.queue.length)).toEqual([{ kind: 'email.send', outboxId }]);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      passId: f.pass.id,
      orgId: f.org.id,
      kind: 'email',
      state: 'enqueued',
      payload: { to: f.to, attach: false, intent: { pass: { passId: f.pass.id } } },
    });
    const after = await effects(f.pass.id);
    expect(after.outbox).toHaveLength(before.outbox.length + 1);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect((await counters(f.org.id, f.to)).map((row) => row.count)).toEqual([1, 1]);
  });
});
