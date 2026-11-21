import type { ScanSetupPlan } from '@/shared/contracts/scan-setup-intent.ts';

/** What Review shows: the plan, and where it came from. */
export interface SetupPreview {
  plan: ScanSetupPlan;
  source: 'server' | 'local';
}
