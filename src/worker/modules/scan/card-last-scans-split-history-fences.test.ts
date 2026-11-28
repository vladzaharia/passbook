import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { RACE_CARD_HISTORY } from './race-tags.ts';
import { type CardHistoryRow, cardHistoryFence, cardHistoryStmt } from './repo-card-history.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, card, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('fences the card history on the pass lineage, ', async () => {
    const { templateId, pass, scanner } = await simple();
    await act(scanner.headers, pass.id);
    const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
    const rows = (await cardHistoryStmt(kit.env.DB, query).all<CardHistoryRow>()).results;
    const fence = cardHistoryFence(query, rows);
    if (!fence) throw new Error('Missing card history fence');
    expect(cardHistoryFence(query, [])).toBeNull();
    expect(fence.params).toEqual([
      pass.id,
      query.orgId,
      query.mode,
      rows[0]?.current_lifecycle_generation,
      rows[0]?.current_credential_generation,
      rows[0]?.id,
    ]);
    const sql = `SELECT CASE WHEN (${fence.sql}) THEN 1 ELSE 0 END AS current`;
    expect(await first(kit.env.DB, sql, [...fence.params])).toEqual({ current: 1 });
    // The rows are one snapshot: renaming the scanner after the read does not unread them.
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['Changed lobby', scanner.id]);
    expect(await first(kit.env.DB, sql, [...fence.params])).toEqual({ current: 1 });
    // An undo does: the card must not show an undone scan as undoable.
    await run(kit.env.DB, 'UPDATE scans SET undone_by=id WHERE id=?', [rows[0]?.id]);
    expect(await first(kit.env.DB, sql, [...fence.params])).toEqual({ current: 0 });
    await run(kit.env.DB, 'UPDATE scans SET undone_by=NULL WHERE id=?', [rows[0]?.id]);
    expect(await first(kit.env.DB, sql, [...fence.params])).toEqual({ current: 1 });
    // A moved pass does: every row was read for the lineage the fence names.
    await run(
      kit.env.DB,
      'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
      [pass.id],
    );
    expect(await first(kit.env.DB, sql, [...fence.params])).toEqual({ current: 0 });
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
    expect(fence.params.length).toBeLessThanOrEqual(90);
    expect(await first(kit.env.DB, `SELECT (${fence.sql}) AS current`, fence.params)).toEqual({
      current: 1,
    });
  });

  /** Run one resolve, applying `change` at the first batch that carries the card history read. */
  async function resolveWithChange(
    scannerHeaders: Record<string, string>,
    passId: string,
    when: 'before' | 'after',
    change: () => Promise<void>,
  ): Promise<{ raced: boolean; outcome: ScanOutcome }> {
    const real = kit.env.DB;
    const historyStatements = new WeakSet<D1PreparedStatement>();
    let raced = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes(RACE_CARD_HISTORY)) return statement;
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
            const carries = statements.some((statement) => historyStatements.has(statement));
            if (when === 'before' && !raced && carries) {
              raced = true;
              await change();
            }
            const result = await target.batch(statements);
            if (when === 'after' && !raced && carries) {
              raced = true;
              await change();
            }
            return result;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const response = await kit.post(scannerHeaders, '/resolve', body(passId));
      expect(response.status).toBe(200);
      return { raced, outcome: (await response.json()) as ScanOutcome };
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  }

  // A change before the read redacts; a change after it leaves the snapshot's answer, and the next
  // request shows the change. The positive control is the unchanged card in both cases.
  it.each([
    ['receipt', 'before'],
    ['actor', 'before'],
    ['receipt', 'after'],
    ['actor', 'after'],
  ] as const)(
    'answers the %s change %s the history read from its snapshot',
    async (changed, when) => {
      const { templateId, pass, scanner } = await simple('Race entry');
      const other = await kit.scanner({ templateIds: [templateId] });
      const scanId = await act(scanner.headers, pass.id);
      const change = async () => {
        if (changed === 'receipt')
          await run(
            kit.env.DB,
            `UPDATE pass_events SET data=json_remove(data,'$.authority.eventProjection')
          WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
            [pass.id, scanId],
          );
        else await run(kit.env.DB, 'UPDATE scans SET actor_id=? WHERE id=?', [other.id, scanId]);
      };
      const { raced, outcome } = await resolveWithChange(scanner.headers, pass.id, when, change);
      expect(raced).toBe(true);
      expect(outcome).toMatchObject({
        kind: 'ready',
        reason: 'choose',
        card: { passId: pass.id },
        counts: { today: 1 },
      });
      const seen = outcome.card?.lastScans.map((row) => row.scanId);
      expect(seen).toEqual(when === 'before' ? [] : [scanId]);
      // The next request reads the changed state.
      const next = await card(scanner.headers, pass.id);
      expect(next.lastScans).toEqual([]);
    },
  );

  it('shows the scan on an unchanged card (positive control)', async () => {
    const { pass, scanner } = await simple('Control entry');
    const scanId = await act(scanner.headers, pass.id);
    expect((await card(scanner.headers, pass.id)).lastScans.map((row) => row.scanId)).toEqual([
      scanId,
    ]);
  });
});
