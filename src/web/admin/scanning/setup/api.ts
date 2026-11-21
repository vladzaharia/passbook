import {
  type ScanSetupIntent,
  ScanSetupPlanSchema,
  type ScanSetupResult,
  ScanSetupResultSchema,
} from '@/shared/contracts/scan-setup-intent.ts';
import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import { api } from '@/web/lib/api.ts';
import { localPreview } from './local-plan.ts';
import type { SetupPreview } from './types.ts';

const PATH = '/api/v1/scanning-sessions/setup';

/** Makes everything in the intent. The key makes a retry replay instead of making twice. */
export function applySetup(
  intent: ScanSetupIntent,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ScanSetupResult> {
  return api.post(PATH, ScanSetupResultSchema, intent, {
    headers: { 'Idempotency-Key': idempotencyKey },
    ...(signal ? { signal } : {}),
  });
}

/**
 * The plan the server would make, writing nothing. While the route is missing (S3) this plans
 * locally instead; see local-plan.ts.
 */
export async function dryRunSetup(
  intent: ScanSetupIntent,
  ctx: SetupPlanContext,
  signal?: AbortSignal,
): Promise<SetupPreview> {
  try {
    const plan = await api.post(PATH, ScanSetupPlanSchema, intent, {
      query: { dryRun: true },
      ...(signal ? { signal } : {}),
    });
    return { plan, source: 'server' };
  } catch (error) {
    return localPreview(error, intent, ctx);
  }
}
