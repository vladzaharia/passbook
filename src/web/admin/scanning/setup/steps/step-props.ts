import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import type { Draft } from '../draft.ts';

export interface StepProps {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  ctx: SetupPlanContext;
}
