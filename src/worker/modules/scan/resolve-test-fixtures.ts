import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let tpl: string;
export const HOUR = 3_600_000;
export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

export async function setupResolveFixture() {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Gym card', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    lookup: { input: 'memberNo' },
    window: { from: 'startsAt', until: 'endsAt' },
    flags: [{ input: 'tier', label: 'Unpaid dues', equals: ['overdue'], stop: true }],
  });
}

export const body = (input: unknown) => ({
  idempotencyKey: key(),
  input,
  clientTs: kit.clock.now(),
});
export const resolve = async (headers: Record<string, string>, input: unknown) => {
  const res = await kit.post(headers, '/resolve', body(input));
  return { status: res.status, out: (await res.json()) as ScanOutcome };
};
export const mask = (o: ScanOutcome) => ({ ...o, scanId: null, at: null });

export async function door(templateIds = [tpl], over: Record<string, unknown> = {}) {
  return kit.scanner({ templateIds, ...over });
}
