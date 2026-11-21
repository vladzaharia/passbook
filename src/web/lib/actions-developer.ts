import { type LucideIcon, RotateCcw, Unlock } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Developer sandbox events beside the create and close labels in actions.ts. */
export const DEVELOPER_ACTIONS = {
  'developer_sandbox.reopen': a('Developer sandbox reopened', Unlock, 'success'),
  'developer_sandbox.reset': a('Developer sandbox reset', RotateCcw, 'warning'),
};
