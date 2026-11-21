import type { ScanSetupPlan } from '@/shared/contracts/scan-setup-intent.ts';

/** What Review shows: the server's plan. */
export interface SetupPreview {
  plan: ScanSetupPlan;
  source: 'server';
}
