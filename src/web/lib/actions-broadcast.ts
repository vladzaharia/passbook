import type { LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Stopping a sending run and undoing a change run. */
export const BROADCAST_RUN_ACTIONS = {
  'broadcast.stop': a('Message stopped', ACTION_ICON.void, 'warning'),
  'broadcast.undo': a('Change undone', ACTION_ICON.restore, 'warning'),
};
