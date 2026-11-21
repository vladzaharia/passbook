import { CircleCheck, type LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Import runs and undoing an import. */
export const IMPORT_UNDO_ACTIONS = {
  'pass_import.commit': a('Import started', ENTITY.pass.icon, 'info'),
  'pass_import.email_rest': a('Import passes emailed', ENTITY.pass.icon, 'info'),
  'pass_import.finish': a('Import finished', CircleCheck, 'success'),
  'pass_import.remove_created': a('Import passes removed', ACTION_ICON.removeFromWallet, 'warning'),
  'pass_import.results_export': a('Import results exported', ENTITY.pass.icon, 'info'),
  'pass_import.undo': a('Import undone', ACTION_ICON.removeFromWallet, 'warning'),
  'pass_import.undo_failed': a('Import undo failed', ACTION_ICON.removeFromWallet, 'danger'),
};
