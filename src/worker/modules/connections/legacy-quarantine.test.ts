import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { dailyConnections, reconcileConnections, WEBHOOK_RETENTION_MS } from './jobs.ts';
import { legacyCleanupHash } from './legacy-duplicate-key.ts';
import { quarantineLegacyWebhookEvents } from './legacy-quarantine.ts';
import type { InboxItem } from './repo-pass-inbox.ts';
import { deleteOldWebhookEvents } from './repo-sync.ts';
import { retainedById } from './repo-webhook-retention.ts';
import { replaceKeysetForTest, startPendingTransfer } from './runtime-fixtures.ts';
import { createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';

let kit: Kit;

beforeEach(async () => {
  kit = await makeKit();
});

async function webhookConnection() {
  return createDemo(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' } as never);
}

async function seedEvent(
  connectionId: string,
  eventId: string,
  receivedAt: number,
  items: InboxItem[] = [],
) {
  await run(
    kit.env.DB,
    'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
    [connectionId, eventId, receivedAt],
  );
  for (const item of items) {
    await run(
      kit.env.DB,
      `INSERT INTO connection_inbox
      (connection_id, event_id, ref, record, deleted, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        connectionId,
        eventId,
        item.ref,
        item.record === null ? null : JSON.stringify(item.record),
        item.deleted ? 1 : 0,
        receivedAt,
      ],
    );
  }
}

interface Marker {
  id: string;
  event_id: string;
  org_id: string;
  generation: number;
  source: string;
  connection_mode: string;
  reference_mode: string;
  ref_hash: string;
  state: string;
  error_code: string | null;
  release_snapshot: string;
  snapshot_known: number;
  credential_keyset_commitment: string | null;
  item_count: number;
  chunk_count: number;
}

function markers(connectionId: string) {
  return all<Marker>(
    kit.env.DB,
    `SELECT id, event_id, org_id, generation, source, connection_mode,
    reference_mode, ref_hash, state, error_code, release_snapshot, snapshot_known, credential_keyset_commitment,
    item_count, chunk_count
    FROM connection_webhook_retention WHERE connection_id = ? ORDER BY event_id, id`,
    [connectionId],
  );
}

function eventRows(connectionId: string) {
  return all<{ event_id: string; received_at: number }>(
    kit.env.DB,
    'SELECT event_id, received_at FROM webhook_events WHERE connection_id = ? ORDER BY event_id',
    [connectionId],
  );
}

function inboxRows(connectionId: string) {
  return all<{
    event_id: string;
    ref: string;
    record: string | null;
    deleted: number;
    received_at: number;
  }>(
    kit.env.DB,
    `SELECT event_id, ref, record, deleted, received_at FROM connection_inbox
      WHERE connection_id = ? ORDER BY event_id, ref`,
    [connectionId],
  );
}

function sources(connectionId: string) {
  return all<{ id: string; event_id: string; iv: string; wrapped: string; ciphertext: string }>(
    kit.env.DB,
    `SELECT id, event_id, hex(iv) AS iv, hex(wrapped_dek) AS wrapped, hex(ciphertext) AS ciphertext
     FROM connection_webhook_legacy_sources WHERE connection_id = ? ORDER BY event_id, id`,
    [connectionId],
  );
}

function itemRows(retentionId: string) {
  return all<{
    ordinal: number;
    state: string;
    error_code: string | null;
    prior_unknown: number;
    release_snapshot: string;
  }>(
    kit.env.DB,
    `SELECT ordinal, state, error_code, prior_unknown, release_snapshot FROM connection_webhook_items
     WHERE retention_id = ? ORDER BY ordinal`,
    [retentionId],
  );
}

async function payload(connectionId: string, retentionId: string) {
  const row = await retainedById(kit.env.DB, connectionId, retentionId);
  if (!row) throw new Error('Missing retained quarantine marker');
  return decryptRetainedPayload(kit.sctx, row);
}

const terminal = (ordinal: number) => ({
  ordinal,
  state: 'failed',
  error_code: 'WEBHOOK_LEGACY_UNCERTAIN',
  prior_unknown: 1,
  release_snapshot: 'null',
});

const hex = (value: string) =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

describe('legacy webhook cleanup quarantine', () => {
  it('makes bounded oldest-first progress, seals exact items and leaves the cutoff untouched', async () => {
    const { id } = await webhookConnection();
    const before = kit.clock.now() - 1_000;
    const items: [InboxItem, InboxItem] = [
      {
        ref: 'private-ref-a-19d2',
        record: { memberName: 'private-member-f746', nested: { value: 7 } },
        deleted: false,
      },
      { ref: 'private-ref-z-56bf', record: null, deleted: true },
    ];
    for (let i = 0; i < 23; i++) {
      await seedEvent(id, `legacy-${String(i).padStart(2, '0')}`, before - 1, i === 0 ? items : []);
    }
    await seedEvent(id, 'at-cutoff', before, [items[0]]);
    await seedEvent(id, 'after-cutoff', before + 1, [items[1]]);

    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 0)).toBe(0);
    expect(await markers(id)).toEqual([]);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 2)).toBe(2);
    expect((await markers(id)).map((row) => row.event_id)).toEqual(['legacy-00', 'legacy-01']);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1_000)).toBe(20);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1_000)).toBe(1);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1_000)).toBe(0);

    const rows = await markers(id);
    expect(rows.map((row) => row.event_id)).toEqual(
      Array.from({ length: 23 }, (_, i) => `legacy-${String(i).padStart(2, '0')}`),
    );
    const row = rows[0];
    if (!row) throw new Error('Missing first legacy marker');
    expect(row).toMatchObject({
      org_id: kit.org.id,
      generation: 1,
      source: 'legacy_cleanup_unproven',
      connection_mode: 'webhook',
      reference_mode: 'unknown',
      state: 'failed',
      error_code: 'WEBHOOK_LEGACY_UNCERTAIN',
      release_snapshot: 'null',
      snapshot_known: 0,
      credential_keyset_commitment: null,
      item_count: 2,
      chunk_count: 1,
    });
    expect(row.ref_hash).toBe(await legacyCleanupHash(kit.sctx, id, 'legacy-00'));
    // Quarantined rows never run, so their items are terminal and fence nothing.
    expect(await itemRows(row.id)).toEqual([terminal(0), terminal(1)]);
    const claimQuery = `SELECT ordinal, claim_pass_id, claim_prior_unbound
      FROM connection_webhook_items WHERE retention_id = ? ORDER BY ordinal`;
    const unresolved = await all(kit.env.DB, claimQuery, [row.id]);
    expect(unresolved).toEqual([
      { ordinal: 0, claim_pass_id: null, claim_prior_unbound: 0 },
      { ordinal: 1, claim_pass_id: null, claim_prior_unbound: 0 },
    ]);
    // A quarantined legacy row no longer blocks the organization's holder transfers.
    const guardedPass = await linkedPass(kit, id, 'later-pass');
    await startPendingTransfer(kit.sctx, guardedPass.id);
    expect(
      await first(kit.env.DB, 'SELECT state FROM pass_credential_transfers WHERE pass_id = ?', [
        guardedPass.id,
      ]),
    ).toEqual({ state: 'pending' });
    const otherOrg = await makeOrg(kit);
    const otherTemplate = makeTemplate({ id: `other-${kit.ids.token(4)}`, orgId: otherOrg.id });
    const otherPass = await makePass(kit, { orgId: otherOrg.id, template: otherTemplate.resolved });
    await startPendingTransfer(kit.sctx, otherPass.id);
    expect(
      await first(kit.env.DB, 'SELECT state FROM pass_credential_transfers WHERE pass_id = ?', [
        otherPass.id,
      ]),
    ).toEqual({ state: 'pending' });
    expect(await deleteOldWebhookEvents(kit.sctx, before)).toBe(0);
    expect(await itemRows(row.id)).toEqual([terminal(0), terminal(1)]);
    expect(await all(kit.env.DB, claimQuery, [row.id])).toEqual(unresolved);
    expect(await payload(id, row.id)).toEqual({
      refs: items.map((item) => item.ref),
      items,
      rawBody: null,
      credentialKeysetCommitment: null,
    });
    const empty = rows[1];
    if (!empty) throw new Error('Missing empty legacy marker');
    expect(empty).toMatchObject({ state: 'failed', item_count: 0, snapshot_known: 0 });
    expect(await itemRows(empty.id)).toEqual([]);
    expect(await payload(id, empty.id)).toEqual({
      refs: [],
      items: [],
      rawBody: null,
      credentialKeysetCommitment: null,
    });
    expect(await eventRows(id)).toHaveLength(25);
    expect((await inboxRows(id)).map((item) => item.event_id)).toEqual([
      'after-cutoff',
      'at-cutoff',
    ]);

    const sealed = await sources(id);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.event_id).toBe('legacy-00');
    expect(sealed[0]?.iv.length).toBeGreaterThan(0);
    expect(sealed[0]?.wrapped.length).toBeGreaterThan(0);
    expect(sealed[0]?.ciphertext.length).toBeGreaterThan(0);
    const stored = JSON.stringify(
      await first(
        kit.env.DB,
        `SELECT hex(iv) AS iv, hex(wrapped_dek) AS wrapped, hex(ciphertext) AS ciphertext
       FROM connection_webhook_retention WHERE id = ?`,
        [row.id],
      ),
    );
    const metadata = JSON.stringify(
      await all(kit.env.DB, 'SELECT * FROM connection_webhook_items WHERE retention_id = ?', [
        row.id,
      ]),
    );
    for (const value of [items[0].ref, items[1].ref, 'private-member-f746']) {
      for (const privateText of [value, btoa(value)]) {
        expect(JSON.stringify(sealed)).not.toContain(hex(privateText));
        expect(stored).not.toContain(hex(privateText));
        expect(metadata).not.toContain(privateText);
      }
    }
    expect(kit.seams.jobs).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it.each(['missing', 'different'] as const)(
    'does not seal or delete legacy inbox data when the keyset sentinel is %s',
    async (sentinel) => {
      const { id } = await webhookConnection();
      const before = kit.clock.now() - 1_000;
      const item: InboxItem = {
        ref: 'private-keyset-ref',
        record: { memberName: 'Private member' },
        deleted: false,
      };
      await seedEvent(id, 'legacy-keyset-fence', before - 1, [item]);
      const originalEvents = await eventRows(id);
      const originalInbox = await inboxRows(id);
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      await replaceKeysetForTest(kit.sctx, sentinel === 'missing' ? null : other);
      try {
        await expect(quarantineLegacyWebhookEvents(kit.sctx, before, 10)).rejects.toMatchObject({
          code: 'WEBHOOK_RETENTION_FAILED',
        });
        expect(await eventRows(id)).toEqual(originalEvents);
        expect(await inboxRows(id)).toEqual(originalInbox);
        expect(await sources(id)).toEqual([]);
        expect(await markers(id)).toEqual([]);
        expect(kit.seams.jobs).toEqual([]);
      } finally {
        await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
      expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
      const [row] = await markers(id);
      if (!row) throw new Error('Missing quarantine marker');
      expect(row).toMatchObject({ state: 'failed', credential_keyset_commitment: null });
      expect(await payload(id, row.id)).toEqual({
        refs: [item.ref],
        items: [item],
        rawBody: null,
        credentialKeysetCommitment: null,
      });
      expect(await inboxRows(id)).toEqual([]);
    },
    60_000,
  );

  it('keeps the unprocessed backlog and unresolved markers safe during retention cleanup', async () => {
    const { id } = await webhookConnection();
    const before = kit.clock.now() - WEBHOOK_RETENTION_MS;
    const items: InboxItem[] = [
      { ref: 'backlog-ref', record: { memberName: 'Backlog' }, deleted: false },
    ];
    await seedEvent(id, 'backlog-first', before - 3, items);
    await seedEvent(id, 'backlog-second', before - 2, items);
    await seedEvent(id, 'backlog-third', before - 1, items);
    const originalEvents = await eventRows(id);
    const originalInbox = await inboxRows(id);

    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1)).toBe(1);
    expect((await markers(id)).map((row) => row.event_id)).toEqual(['backlog-first']);
    expect(await deleteOldWebhookEvents(kit.sctx, before)).toBe(0);
    expect(await eventRows(id)).toEqual(originalEvents);
    expect(await inboxRows(id)).toEqual(
      originalInbox.filter((row) => row.event_id !== 'backlog-first'),
    );

    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1)).toBe(1);
    expect(await deleteOldWebhookEvents(kit.sctx, before)).toBe(0);
    expect(await eventRows(id)).toEqual(originalEvents);
    expect((await inboxRows(id)).map((row) => row.event_id)).toEqual(['backlog-third']);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1)).toBe(1);
    expect(await deleteOldWebhookEvents(kit.sctx, before)).toBe(0);
    expect(await eventRows(id)).toEqual(originalEvents);
    expect(await inboxRows(id)).toEqual([]);
    expect((await markers(id)).every((row) => row.state === 'failed')).toBe(true);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 1)).toBe(0);
  }, 60_000);

  it('rolls back the marker and preserves the original rows if plaintext deletion fails', async () => {
    const { id } = await webhookConnection();
    const before = kit.clock.now() - 1_000;
    const items: InboxItem[] = [
      { ref: 'original-a', record: { memberName: 'Original A' }, deleted: false },
      { ref: 'original-b', record: null, deleted: true },
    ];
    await seedEvent(id, 'seal-failure', before - 1, items);
    const originalEvents = await eventRows(id);
    const originalInbox = await inboxRows(id);
    let sourceId: string | undefined;
    await run(
      kit.env.DB,
      `CREATE TRIGGER quarantine_reject_inbox_delete BEFORE DELETE ON connection_inbox
      BEGIN SELECT RAISE(ABORT, 'injected inbox deletion failure'); END`,
    );
    try {
      // The failing event is logged and skipped, not thrown.
      expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(0);
      expect(await eventRows(id)).toEqual(originalEvents);
      expect(await inboxRows(id)).toEqual(originalInbox);
      const sealed = await sources(id);
      expect(sealed).toHaveLength(1);
      sourceId = sealed[0]?.id;
      expect(await markers(id)).toEqual([]);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER quarantine_reject_inbox_delete');
    }
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
    const [row] = await markers(id);
    if (!row) throw new Error('Missing retried quarantine marker');
    expect(await payload(id, row.id)).toEqual({
      refs: items.map((item) => item.ref),
      items,
      rawBody: null,
      credentialKeysetCommitment: null,
    });
    expect(await eventRows(id)).toEqual(originalEvents);
    expect(await inboxRows(id)).toEqual([]);
    expect((await sources(id)).map((source) => source.id)).toContain(sourceId);
  }, 60_000);

  it('atomically stages each marker and its items, retaining earlier progress and safe retry data', async () => {
    const { id } = await webhookConnection();
    const before = kit.clock.now() - 1_000;
    const firstItems: InboxItem[] = [
      { ref: 'first-a', record: { memberName: 'First' }, deleted: false },
    ];
    const secondItems: InboxItem[] = [
      { ref: 'second-a', record: { memberName: 'Second A' }, deleted: false },
      { ref: 'second-b', record: { memberName: 'Second B' }, deleted: false },
    ];
    await seedEvent(id, 'partial-first', before - 2, firstItems);
    await seedEvent(id, 'partial-second', before - 1, secondItems);
    const originalEvents = await eventRows(id);
    const originalInbox = await inboxRows(id);
    await run(
      kit.env.DB,
      `CREATE TRIGGER quarantine_reject_second_item BEFORE INSERT ON connection_webhook_items
      WHEN NEW.ordinal = 1 AND EXISTS (SELECT 1 FROM connection_webhook_retention
        WHERE id = NEW.retention_id AND event_id = 'partial-second')
      BEGIN SELECT RAISE(ABORT, 'injected item staging failure'); END`,
    );
    let firstMarker: Marker | undefined;
    try {
      // The first event is staged; the second fails alone and is retried later.
      expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
      const rows = await markers(id);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('Missing earlier quarantine marker');
      firstMarker = row;
      expect(row.event_id).toBe('partial-first');
      expect(await itemRows(row.id)).toEqual([terminal(0)]);
      expect(await eventRows(id)).toEqual(originalEvents);
      expect(await inboxRows(id)).toEqual(
        originalInbox.filter((row) => row.event_id === 'partial-second'),
      );
      expect((await sources(id)).map((source) => source.event_id)).toEqual([
        'partial-first',
        'partial-second',
      ]);
      expect(
        await all(
          kit.env.DB,
          `SELECT i.retention_id FROM connection_webhook_items i
        LEFT JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.id IS NULL`,
        ),
      ).toEqual([]);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER quarantine_reject_second_item');
    }
    if (!firstMarker) throw new Error('Missing earlier quarantine marker');

    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
    const rows = await markers(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(firstMarker);
    const second = rows[1];
    if (!second) throw new Error('Missing retried second quarantine marker');
    expect(second).toMatchObject({ event_id: 'partial-second', state: 'failed', item_count: 2 });
    expect(await itemRows(second.id)).toEqual([terminal(0), terminal(1)]);
    expect(await payload(id, second.id)).toEqual({
      refs: secondItems.map((item) => item.ref),
      items: secondItems,
      rawBody: null,
      credentialKeysetCommitment: null,
    });
    const sealed = await sources(id);
    const envelopeSql = `SELECT hex(iv) AS iv, hex(wrapped_dek) AS wrapped, hex(ciphertext) AS ciphertext,
      revision, updated_at FROM connection_webhook_retention WHERE id = ?`;
    const envelope = await first(kit.env.DB, envelopeSql, [second.id]);
    const itemsBefore = await itemRows(second.id);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(0);
    expect(await markers(id)).toEqual(rows);
    expect(await sources(id)).toEqual(sealed);
    expect(await first(kit.env.DB, envelopeSql, [second.id])).toEqual(envelope);
    expect(await itemRows(second.id)).toEqual(itemsBefore);
    expect(await eventRows(id)).toEqual(originalEvents);
  }, 60_000);

  it('preserves a late inbox write when the observed source changes before staging', async () => {
    const { id } = await webhookConnection();
    const before = kit.clock.now() - 1_000;
    const original: InboxItem = {
      ref: 'race-original',
      record: { memberName: 'Original' },
      deleted: false,
    };
    const late: InboxItem = { ref: 'race-late', record: { memberName: 'Late' }, deleted: false };
    await seedEvent(id, 'race-event', before - 1, [original]);
    let pendingStage = false;
    let injected = false;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (/INSERT\s+INTO\s+connection_webhook_retention/i.test(sql)) pendingStage = true;
            return target.prepare(sql);
          };
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (pendingStage && !injected) {
              pendingStage = false;
              injected = true;
              await run(
                target,
                `INSERT INTO connection_inbox
              (connection_id, event_id, ref, record, deleted, received_at) VALUES (?, ?, ?, ?, 0, ?)`,
                [id, 'race-event', late.ref, JSON.stringify(late.record), before - 1],
              );
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racingContext = { ...kit.sctx, env: { ...kit.env, DB: db } };
    expect(await quarantineLegacyWebhookEvents(racingContext, before, 10)).toBe(0);
    expect(injected).toBe(true);
    expect(await markers(id)).toEqual([]);
    const sealed = await sources(id);
    expect(sealed.map((source) => source.event_id)).toEqual(['race-event']);
    expect((await inboxRows(id)).map((item) => item.ref)).toEqual([late.ref, original.ref]);
    expect((await eventRows(id)).map((event) => event.event_id)).toEqual(['race-event']);

    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
    const [row] = await markers(id);
    if (!row) throw new Error('Missing raced quarantine marker');
    const recovered = await payload(id, row.id);
    expect(recovered.items.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([late, original]);
    expect(recovered.refs).toHaveLength(2);
    expect(await itemRows(row.id)).toHaveLength(2);
    expect(
      (await itemRows(row.id)).every((item) => item.state === 'failed' && item.prior_unknown === 1),
    ).toBe(true);
    expect(await inboxRows(id)).toEqual([]);
    expect(await sources(id)).toEqual(expect.arrayContaining(sealed));
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(0);
  }, 60_000);

  it('quarantines disabled non-webhook connections without granting execution authority', async () => {
    const { id } = await createDemo(kit);
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [id]);
    const before = kit.clock.now() - 1_000;
    const item: InboxItem = {
      ref: 'inactive-ref',
      record: { memberName: 'Inactive' },
      deleted: false,
    };
    await seedEvent(id, 'inactive-event', before - 1, [item]);
    expect(await quarantineLegacyWebhookEvents(kit.sctx, before, 10)).toBe(1);
    const [row] = await markers(id);
    if (!row) throw new Error('Missing inactive quarantine marker');
    expect(row).toMatchObject({
      connection_mode: 'unknown',
      reference_mode: 'unknown',
      source: 'legacy_cleanup_unproven',
      state: 'failed',
      error_code: 'WEBHOOK_LEGACY_UNCERTAIN',
      release_snapshot: 'null',
      snapshot_known: 0,
    });
    expect(await itemRows(row.id)).toEqual([terminal(0)]);
    expect(await payload(id, row.id)).toEqual({
      refs: [item.ref],
      items: [item],
      rawBody: null,
      credentialKeysetCommitment: null,
    });
    expect(kit.seams.jobs).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it('quarantines before retention deletion, fails closed, and never logs sensitive data', async () => {
    const { id, webhookSecret } = await webhookConnection();
    if (!webhookSecret) throw new Error('Missing webhook secret');
    const before = kit.clock.now() - WEBHOOK_RETENTION_MS;
    const firstEvent = 'private-cleanup-event-91cd';
    const failedEvent = 'private-failed-event-e91a';
    const privateRef = 'private-cleanup-ref-6c11';
    const privateValue = 'private-cleanup-member-0c82';
    const failureDetail = 'private-storage-failure-4e12';
    await seedEvent(id, firstEvent, before - 2, [
      { ref: privateRef, record: { memberName: privateValue }, deleted: false },
    ]);
    await seedEvent(id, failedEvent, before - 1, [
      {
        ref: 'failed-private-ref-0ff2',
        record: { memberName: 'failed-private-value-2ed9' },
        deleted: false,
      },
    ]);
    await seedEvent(id, 'recent-event', before, [
      { ref: 'recent-ref', record: { memberName: 'Recent' }, deleted: false },
    ]);
    const originalEvents = await eventRows(id);
    const lines: string[] = [];
    kit.sctx = {
      ...kit.sctx,
      log: createLogger({}, { level: 'debug', sink: (line) => lines.push(line) }),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run(
        kit.env.DB,
        `CREATE TRIGGER quarantine_reject_failed_source
        BEFORE INSERT ON connection_webhook_legacy_sources WHEN NEW.event_id = '${failedEvent}'
        BEGIN SELECT RAISE(ABORT, '${failureDetail}'); END`,
      );
      try {
        // One bad legacy event is logged; the run and the other retention steps still complete.
        await dailyConnections(kit.sctx);
        expect(
          lines.some((line) => line.includes('connection.legacy_event_quarantine_failed')),
        ).toBe(true);
        expect(lines.some((line) => line.includes('connections.retention'))).toBe(true);
        await reconcileConnections(kit.sctx);
        // The minute cron retries the failed event and logs it again without throwing.
        expect(
          lines.filter((line) => line.includes('connection.legacy_event_quarantine_failed')).length,
        ).toBeGreaterThanOrEqual(2);
        expect(await eventRows(id)).toEqual(originalEvents);
        expect((await markers(id)).map((row) => row.event_id)).toEqual([firstEvent]);
        expect((await inboxRows(id)).map((row) => row.event_id)).toEqual([
          failedEvent,
          'recent-event',
        ]);
        expect((await sources(id)).map((row) => row.event_id)).toEqual([firstEvent]);
      } finally {
        await run(kit.env.DB, 'DROP TRIGGER quarantine_reject_failed_source');
      }
      await dailyConnections(kit.sctx);
      expect(await eventRows(id)).toEqual(originalEvents);
      const retained = await markers(id);
      expect(retained.map((row) => row.event_id)).toEqual([failedEvent, firstEvent].sort());
      expect(
        retained.every((row) => row.state === 'failed' && row.source === 'legacy_cleanup_unproven'),
      ).toBe(true);
      expect((await inboxRows(id)).map((row) => row.event_id)).toEqual(['recent-event']);
      const sealed = await sources(id);
      expect(sealed).toHaveLength(2);
      await dailyConnections(kit.sctx);
      expect(await markers(id)).toEqual(retained);
      expect(await sources(id)).toEqual(sealed);
      expect(await eventRows(id)).toEqual(originalEvents);

      const consoleCalls = [
        ...log.mock.calls,
        ...debug.mock.calls,
        ...info.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ].map((args) =>
        args
          .map((arg) =>
            arg instanceof Error
              ? [arg.message, arg.stack, String(arg.cause ?? '')].join(' ')
              : JSON.stringify(arg),
          )
          .join(' '),
      );
      const logged = [...lines, ...consoleCalls].join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const value of [
        firstEvent,
        failedEvent,
        privateRef,
        privateValue,
        'failed-private-ref-0ff2',
        'failed-private-value-2ed9',
        failureDetail,
        webhookSecret,
      ]) {
        expect(logged).not.toContain(value);
        expect(logged).not.toContain(btoa(value));
      }
    } finally {
      log.mockRestore();
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);
});
