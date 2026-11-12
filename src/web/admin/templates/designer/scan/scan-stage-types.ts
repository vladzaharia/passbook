import type { ScanAction } from '@/passkit/types.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';

export type PreviewTab = {
  id: string;
  label: string;
  screen: ScanDisplayScreen;
  action?: ScanAction;
};
export type ScanStageAction = 'up' | 'down' | 'duplicate' | 'remove';
