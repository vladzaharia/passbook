import { describe, expect, it, vi } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

// The app's module graph is loaded before a test file's `vi.mock` registers, so a spy on
// `publishScan` never sees the route's call; the hub stub below observes every real publication.
describe('scanner action live publication', () => {
  it('publishes the first action once and nothing for the same-key receipt', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Replay live', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    await kit.scanner({ deviceRole: 'monitor' });
    const pass = await kit.scanPass(template);
    const body = {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const delivered: unknown[] = [];
    const originalHub = kit.env.SCAN_HUB;
    Object.assign(kit.env, {
      SCAN_HUB: {
        getByName: () => ({
          publish: async (event: unknown) => {
            delivered.push(event);
            return true;
          },
        }),
      },
    });
    try {
      const firstResponse = await kit.post(scanner.headers, '/actions', body);
      expect(firstResponse.status).toBe(200);
      const initial = ScanOutcomeSchema.parse(await firstResponse.json());
      expect(initial).toMatchObject({ kind: 'ok', replay: false });
      await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 5000 });

      const replayResponse = await kit.post(scanner.headers, '/actions', body);
      expect(replayResponse.status).toBe(200);
      const replay = ScanOutcomeSchema.parse(await replayResponse.json());
      expect(replay).toMatchObject({ replay: true, scanId: initial.scanId });
      // Let any stray asynchronous publication land before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivered).toHaveLength(1);
      expect(
        (
          await first<{ n: number }>(
            kit.env.DB,
            'SELECT COUNT(*) AS n FROM scans WHERE idempotency_key = ?',
            [body.idempotencyKey],
          )
        )?.n,
      ).toBe(1);
    } finally {
      Object.assign(kit.env, { SCAN_HUB: originalHub });
    }
  });
});
