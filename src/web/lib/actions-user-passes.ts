import { Eye, type LucideIcon } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** A platform admin reading a person's passes across organizations. */
export const USER_PASSES_ACTIONS = {
  'platform.user_passes_read': a('Passes viewed', Eye, 'info'),
};
