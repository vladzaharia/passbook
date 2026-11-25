import {
  Archive,
  ArrowRightLeft,
  ImagePlus,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Tag keysets: creating, rotating, recovering after a leak, importing. */
export const TAG_KEY_ACTIONS = {
  'tag_keyset.create': a('Tag keys created', ShieldCheck, 'success'),
  'tag_keyset.rotate': a('Tag keys rotated', ACTION_ICON.rotate, 'info'),
  'tag_keyset.retire_key': a('Old tag keys retired', Archive, 'warning'),
  'tag_keyset.revoke_key': a('Tag keys revoked', ShieldAlert, 'danger'),
  'tag_keyset.reenrol': a('Tags moved to new keys', ArrowRightLeft, 'warning'),
  'tag_keyset.disable': a('Tag keys disabled', ShieldX, 'danger'),
  'tag_keyset.import': a('Tags imported', ImagePlus, 'success'),
  'tag_keyset.rekey': a('Tag key replace started', ACTION_ICON.rotate, 'warning'),
  'tag_keyset.rekeyed': a('Tag keys replaced', ACTION_ICON.rotate, 'warning'),
  'nfc_tag.program_started': a('Tag setup started', ShieldCheck, 'info'),
  'nfc_tag.programmed': a('Tag set up', ShieldCheck, 'success'),
  'nfc_tag.program_failed': a('Tag setup failed', ShieldAlert, 'warning'),
};
