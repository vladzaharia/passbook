import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Plain facts', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

describe('scan ledger events record plain facts', () => {
  it('writes the event-time facts and no proof material', async () => {
    const pass = await kit.scanPass(templateId, { memberName: 'Plain guest' });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
      input: { code: pass.scanCode ?? '', method: 'camera' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ScanOutcome).kind).toBe('ok');
    const row = await first<{ data: string; actor_type: string; actor_id: string }>(
      kit.env.DB,
      "SELECT data, actor_type, actor_id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    if (!row) throw new Error('Missing ledger event');
    const data = JSON.parse(row.data);
    expect(row).toMatchObject({ actor_type: 'scanner', actor_id: scanner.id });
    expect(data).toMatchObject({ outcome: 'ok', scannerId: scanner.id });
    expect(data.authority).toMatchObject({
      templateId,
      role: expect.any(String),
      credentialGeneration: expect.any(Number),
      lifecycleGeneration: expect.any(Number),
      releaseClass: expect.stringMatching(/^(legacy|approved)$/),
    });
    for (const proof of [
      'eventProof',
      'credentialKeysetCommitment',
      'scannerCsrfProof',
      'sessionCsrfProof',
    ])
      expect(data.authority).not.toHaveProperty(proof);
  });
});
