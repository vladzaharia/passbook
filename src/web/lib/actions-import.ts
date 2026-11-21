import type { LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Undoing an import. */
export const IMPORT_UNDO_ACTIONS = {
  'pass_import.undo': a('Import undone', ACTION_ICON.removeFromWallet, 'warning'),
  'pass_import.undo_failed': a('Import undo failed', ACTION_ICON.removeFromWallet, 'danger'),
};
