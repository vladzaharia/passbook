import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

// A receipt is the scanner's own recorded scan inside the scope its assignment grants now
// (`ownScansWhere`): moved to another event or template list, it no longer replays.
describe('replay after the scanner is reassigned', () => {
  it('serves the receipt while assigned, and answers unknown once moved to another event', async () => {
    const templateId = await kit.scanTemplate('Replay reassigned', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const first = await kit.event({ templateIds: [templateId] });
    const second = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: first.id, templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    const request = {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const original = await (await kit.post(scanner.headers, '/actions', request)).json();
    expect(original).toMatchObject({ kind: 'ok' });
    const same = await (await kit.post(scanner.headers, '/actions', request)).json();
    expect(same).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: (original as { scanId: string }).scanId,
    });
    await run(kit.env.DB, 'UPDATE scanners SET event_id=? WHERE id=?', [second.id, scanner.id]);
    const moved = await kit.post(scanner.headers, '/actions', request);
    expect(moved.status).toBe(200);
    const body = await moved.json();
    expect(body).toMatchObject({ kind: 'refused', reason: 'not_found', replay: false });
    expect(JSON.stringify(body)).not.toContain(pass.id);
  });
});
