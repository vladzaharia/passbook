import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { type CardHistoryRow, cardHistoryFence, cardHistoryStmt } from './repo-card-history.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('keeps card history source scalars out of packed JSON while preserving the exact fence', async () => {
    const { templateId, pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
    const rows = (await cardHistoryStmt(kit.env.DB, query).all<CardHistoryRow>()).results;
    const row = rows[0];
    if (!row?.event_json || !row.recorded_manifest) throw new Error('Missing signed card history');
    const fence = cardHistoryFence(query, rows);
    if (!fence) throw new Error('Missing card history fence');
    const slots = scanSecretSlots(fence.sql, fence.params.length);
    if (!slots) throw new Error('Invalid card history bind labels');
    const scopeOffset = fence.params.length - 4 - rows.length;
    expect(fence.params.slice(scopeOffset, scopeOffset + 4)).toEqual([
      query.orgId,
      query.mode,
      query.passId,
      query.templateId,
    ]);
    expect(slots.slice(scopeOffset, scopeOffset + 4).map((slot) => slot.label)).toEqual([
      'card-history',
      null,
      'card-history',
      'card-history',
    ]);
    expect(fence.params.slice(-rows.length)).toEqual(rows.map((item) => item.id));
    expect(slots.slice(-rows.length).every((slot) => slot.label === 'card-history')).toBe(true);

    const sensitive = [
      scanId,
      row.org_id,
      row.pass_id,
      row.template_id,
      row.scanner_id,
      row.actor_key,
      row.request_hash,
      row.action_id,
      row.scanner_name,
      row.event_json,
      row.current_personalization,
      row.recorded_personalization,
      row.recorded_manifest,
      row.recorded_wallet_manifest,
      row.event_active_manifest,
      row.event_legacy_manifest,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const value of [
      ...sensitive,
      row.at,
      row.pass_version,
      row.recorded_wallet_version,
      row.current_credential_generation,
      row.current_lifecycle_generation,
      row.current_pending_transfer,
    ]) {
      expect(
        slots.some((slot, index) => slot.label === 'card-history' && fence.params[index] === value),
      ).toBe(true);
    }
    const packed = packScanPredicate(fence.sql, fence.params, 'card_history_test');
    if (!packed || typeof packed.params[0] !== 'string')
      throw new Error('Card fence could not be packed');
    const metadata = JSON.parse(packed.params[0]) as unknown[];
    for (const value of sensitive) {
      expect(metadata).not.toContain(value);
      expect(packed.params.slice(1)).toContain(value);
    }

    // A sensitive field must promote a deduplicated slot first seen as an enum value.
    const collision = cardHistoryFence(query, [{ ...row, reason: row.outcome }]);
    if (!collision) throw new Error('Missing collision fence');
    const collisionSlots = scanSecretSlots(collision.sql, collision.params.length);
    if (!collisionSlots) throw new Error('Invalid collision bind labels');
    expect(
      collisionSlots.some(
        (slot, index) => slot.label === 'card-history' && collision.params[index] === row.outcome,
      ),
    ).toBe(true);

    const sql = `SELECT CASE WHEN (${packed.sql}) THEN 1 ELSE 0 END AS current`;
    expect(await first(kit.env.DB, sql, packed.params)).toEqual({ current: 1 });
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['Changed lobby', scanner.id]);
    expect(await first(kit.env.DB, sql, packed.params)).toEqual({ current: 0 });
  });

  it('fits three distinct proven card scans within the bounded secret-bind fence', async () => {
    const templateId = await kit.scanTemplate('Bounded card history', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      ids.push(await act(scanner.headers, pass.id));
      kit.clock.advance(1);
    }
    const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
    const rows = (await cardHistoryStmt(kit.env.DB, query).all<CardHistoryRow>()).results;
    expect(rows.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);
    const fence = cardHistoryFence(query, rows);
    if (!fence) throw new Error('Missing card history fence');
    const bounded = boundOutputPredicate(fence);
    expect(bounded.sql).not.toBe('0');
    expect(bounded.params.length).toBeLessThanOrEqual(90);
    expect(await first(kit.env.DB, `SELECT (${bounded.sql}) AS current`, bounded.params)).toEqual({
      current: 1,
    });
  });

  it.each(['receipt', 'actor'] as const)(
    'clears stale history but keeps the authorized card and counts when the %s changes',
    async (changed) => {
      const { templateId, pass, scanner } = await simple('Race entry');
      const other = await kit.scanner({ templateIds: [templateId] });
      const scanId = await act(scanner.headers, pass.id);
      const real = kit.env.DB;
      const historyStatements = new WeakSet<D1PreparedStatement>();
      let raced = false;
      const db = new Proxy(real, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('WITH selected_scans AS MATERIALIZED')) return statement;
              return new Proxy(statement, {
                get(prepared, member) {
                  if (member === 'bind')
                    return (...values: unknown[]) => {
                      const bound = prepared.bind(...values);
                      historyStatements.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(prepared, member, prepared);
                  return typeof value === 'function' ? value.bind(prepared) : value;
                },
              });
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (!raced && statements.some((statement) => historyStatements.has(statement))) {
                raced = true;
                if (changed === 'receipt') {
                  await run(
                    real,
                    `UPDATE pass_events SET data=json_remove(data,'$.authority.eventProjection')
                  WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
                    [pass.id, scanId],
                  );
                } else {
                  await run(real, 'UPDATE scans SET actor_id=? WHERE id=?', [other.id, scanId]);
                }
              }
              return result;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: db });
      let response: Response;
      try {
        response = await kit.post(scanner.headers, '/resolve', body(pass.id));
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(raced).toBe(true);
      expect(response.status).toBe(200);
      const outcome = (await response.json()) as ScanOutcome;
      expect(outcome).toMatchObject({
        kind: 'ready',
        reason: 'choose',
        card: { passId: pass.id, lastScans: [] },
        counts: { today: 1 },
      });
      expect(JSON.stringify(outcome.card?.lastScans)).not.toContain(scanId);
    },
  );
});
