import { Ban, type LucideIcon, RotateCcw } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Stop and Retry on a long-running action (an operation); the words match the tray and the panel. */
export const OPERATION_ACTIONS = {
  'operation.cancelled': a('Stopped an action', Ban, 'warning'),
  'operation.retried': a('Retried an action', RotateCcw, 'info'),
};
