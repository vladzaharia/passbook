import type { LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Bulk runs over every pass a filter matches. */
export const PASS_RUN_ACTIONS = {
  'pass.bulk_run': a('Bulk run started', ACTION_ICON.updateDevices, 'info'),
};
