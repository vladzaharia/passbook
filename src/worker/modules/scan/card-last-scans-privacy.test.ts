import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { readCard } from './card.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { planCounts } from './counts.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, card, last, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('shows a proven ordinary action and same-organization scanner to another scanner', async () => {
    const { templateId, pass, scanner } = await simple();
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['Lobby scanner', scanner.id]);
    const scanId = await act(scanner.headers, pass.id);
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
      [pass.id, scanId],
    );
    expect(event).not.toBeNull();
    expect(event!.data).not.toContain('Lobby scanner');
    expect(event!.data).not.toContain('Admit member');
    const reader = await kit.scanner({ templateIds: [templateId] });
    expect(last(await card(reader.headers, pass.id), scanId)).toMatchObject({
      actionLabel: 'Admit member',
      scannerName: 'Lobby scanner',
      undoable: false,
    });
    expect(last(await card(scanner.headers, pass.id), scanId)).toMatchObject({
      actionLabel: 'Admit member',
      scannerName: 'Lobby scanner',
      undoable: true,
    });
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['South lobby', scanner.id]);
    expect(last(await card(reader.headers, pass.id), scanId)).toMatchObject({
      actionLabel: 'Admit member',
      scannerName: 'Scanner',
    });
  });

  it('shows an admin scan as Console rather than inventing a scanner identity', async () => {
    const { templateId, pass, scanner } = await simple();
    const response = await kit.post(kit.admin(), '/actions', {
      ...body(pass.id),
      actionId: 'enter',
      scope: { orgId: kit.org.id, templateIds: [templateId], timeZone: 'UTC' },
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Expected a committed admin scan');
    expect(last(await card(scanner.headers, pass.id), outcome.scanId)).toMatchObject({
      actionLabel: 'Admit member',
      scannerName: 'Console',
    });
  });

  it('uses a captured undo window without a separate settings read', async () => {
    const { pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    kit.clock.advance(60_001);
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
    const prepared: string[] = [];
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            prepared.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: db } };
    const result = await readCard(ctx, actor, found, planCounts(ctx, actor), 'read', 1);
    expect(result?.card.lastScans.find((row) => row.scanId === scanId)).toMatchObject({
      undoable: false,
    });
    expect(prepared.some((sql) => sql.includes('FROM settings'))).toBe(false);
  });

  it('omits a pass-bound actionless refusal from exposable card history', async () => {
    const { pass, scanner } = await simple();
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    const response = await kit.post(scanner.headers, '/actions', {
      ...body(pass.id),
      actionId: 'enter',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'voided' });
    if (!outcome.scanId) throw new Error('Expected a recorded actionless refusal');
    expect(
      await first(
        kit.env.DB,
        'SELECT pass_id,action_id,action_kind,outcome FROM scans WHERE id=?',
        [outcome.scanId],
      ),
    ).toMatchObject({ pass_id: pass.id, action_id: null, action_kind: null, outcome: 'refused' });
    await run(kit.env.DB, "UPDATE passes SET status='active' WHERE id=?", [pass.id]);
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === outcome.scanId),
    ).toBeUndefined();
  });
});
