import type { LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Tag key changes made after a leak. */
export const TAG_KEY_ACTIONS = {
  'tag_keyset.rekey': a('Tag keys replaced', ACTION_ICON.rotate, 'warning'),
};
