import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeScanStaff } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { readCard } from './card.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { planCounts } from './counts.ts';
import { type CardHistoryRow, cardHistoryStmt } from './repo-card-history.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, card } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('refills three proven scans past newer unprovable candidates in newest-first order', async () => {
    const templateId = await kit.scanTemplate('History refill', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await act(scanner.headers, pass.id));
      kit.clock.advance(1);
    }
    // An event without its role projection cannot establish card history.
    for (const id of ids.slice(3))
      await run(
        kit.env.DB,
        `UPDATE pass_events SET data=json_remove(data,'$.authority.eventProjection')
        WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
        [pass.id, id],
      );
    const scans = (await card(scanner.headers, pass.id)).lastScans;
    expect(scans.map((row) => row.scanId)).toEqual([ids[2], ids[1], ids[0]]);
    expect(scans.every((row) => row.actionLabel === 'Admit member')).toBe(true);
  });

  it('rechecks only the selected card history snapshots', async () => {
    const templateId = await kit.scanTemplate('Selected history fence', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await act(scanner.headers, pass.id));
      kit.clock.advance(1);
    }
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_remove(data,'$.authority.eventProjection')
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      [pass.id, ids[3]!],
    );
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    const result = await readCard(kit.ctx, actor, found, planCounts(kit.ctx, actor), 'read');
    if (!result?.historyFence) throw new Error('Expected selected history fence');
    expect(result.card.lastScans.map((row) => row.scanId)).toEqual([ids[2], ids[1], ids[0]]);
    expect(await outputPredicateStmt(kit.env.DB, result.historyFence).first()).toMatchObject({
      authorized: 1,
    });
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_set(data,'$.reason','changed')
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      [pass.id, ids[3]!],
    );
    expect(await outputPredicateStmt(kit.env.DB, result.historyFence).first()).toMatchObject({
      authorized: 1,
    });
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_remove(data,'$.authority.eventProjection')
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      [pass.id, ids[2]!],
    );
    expect(await outputPredicateStmt(kit.env.DB, result.historyFence).first()).toMatchObject({
      authorized: 0,
    });
  });

  it('returns only the proven subset within the 64-candidate budget', async () => {
    const templateId = await kit.scanTemplate('Bounded history', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const oldest = await act(scanner.headers, pass.id);
    const at = kit.clock.now();
    const prefix = `unproven-${pass.id}`;
    expect(
      await run(
        kit.env.DB,
        `WITH RECURSIVE candidate(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM candidate WHERE n<64
    ) INSERT INTO scans (id,org_id,mode,pass_id,template_id,actor_type,actor_id,actor_key,
      idempotency_key,request_hash,method,state,outcome,reason,at)
      SELECT ? || '-' || n, ?, ?, ?, ?, 'system', 'unproven', ?, ? || '-' || n,
        'unproven', 'manual', 'done', 'refused', 'not_found', ?+n FROM candidate`,
        [prefix, pass.orgId, pass.mode, pass.id, templateId, prefix, prefix, at],
      ),
    ).toEqual({ changes: 64 });
    kit.clock.advance(65);
    const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
    const candidates = (await cardHistoryStmt(kit.env.DB, query).all<CardHistoryRow>()).results;
    expect(candidates).toHaveLength(64);
    expect(candidates.some((row) => row.id === oldest)).toBe(false);
    const response = await kit.post(scanner.headers, '/resolve', body(pass.id));
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome).toMatchObject({ kind: 'ready', card: { lastScans: [] }, counts: { today: 1 } });
  });

  it.each([
    'event_id',
    'staff_id',
    'approved_by',
    'actor_id',
    'undoes',
    'undone_by',
    'override_of',
  ] as const)(
    'excludes a foreign or cross-pass %s relation before the history limit',
    async (column) => {
      const templateId = await kit.scanTemplate('History relation scope', {
        actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
      });
      const pass = await kit.scanPass(templateId);
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(await act(scanner.headers, pass.id));
        kit.clock.advance(1);
      }
      const foreignOrg = await makeOrg(kit.fx);
      let foreignId: string;
      if (column === 'event_id') {
        foreignId = (await kit.event({ orgId: foreignOrg.id })).id;
      } else if (column === 'staff_id' || column === 'approved_by') {
        foreignId = (await makeScanStaff(kit.fx, { orgId: foreignOrg.id })).id;
      } else if (column === 'actor_id') {
        foreignId = (await kit.scanner({ orgId: foreignOrg.id })).id;
      } else {
        const otherPass = await kit.scanPass(templateId);
        foreignId = await act(scanner.headers, otherPass.id);
      }
      await run(kit.env.DB, `UPDATE scans SET ${column}=? WHERE id=?`, [foreignId, ids[3]!]);
      const scans = (await card(scanner.headers, pass.id)).lastScans;
      expect(scans.map((row) => row.scanId)).toEqual([ids[2], ids[1], ids[0]]);
      expect(scans.every((row) => row.actionLabel === 'Admit member')).toBe(true);
    },
  );
});
