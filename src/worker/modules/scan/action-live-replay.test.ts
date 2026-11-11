import { describe, expect, it, vi } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import type * as LiveModule from './live.ts';
import { publishScan } from './live.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

vi.mock('./live.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return { ...actual, publishScan: vi.fn(actual.publishScan) };
});

describe('scanner action live publication', () => {
  it('publishes the first action once but never calls publication for the same-key receipt', async () => {
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
    vi.mocked(publishScan).mockClear();
    try {
      const firstResponse = await kit.post(scanner.headers, '/actions', body);
      expect(firstResponse.status).toBe(200);
      const initial = ScanOutcomeSchema.parse(await firstResponse.json());
      expect(initial).toMatchObject({ kind: 'ok', replay: false });
      await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 5000 });
      expect(vi.mocked(publishScan)).toHaveBeenCalledTimes(1);

      const replayResponse = await kit.post(scanner.headers, '/actions', body);
      expect(replayResponse.status).toBe(200);
      const replay = ScanOutcomeSchema.parse(await replayResponse.json());
      expect(replay).toMatchObject({ replay: true, scanId: initial.scanId });
      expect(vi.mocked(publishScan)).toHaveBeenCalledTimes(1);
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
      vi.mocked(publishScan).mockClear();
    }
  });
});
