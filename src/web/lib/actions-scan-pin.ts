import { Lock, type LucideIcon } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Staff PIN limits and sign-in by PIN alone. */
export const SCAN_PIN_ACTIONS = {
  'scan_staff.pin_locked': a('PIN locked after 5 tries', Lock, 'warning'),
  'scanner.pin_flood': a('Scanner PINs locked after 20 tries', Lock, 'warning'),
  'scan_staff.pin_shared': a('PIN shared with another person', Lock, 'warning'),
  'scan_staff.pin_self_reset': a('Staff chose a new PIN', Lock, 'info'),
  'scan_staff.pin_unlock': a('Daily PIN lock lifted', Lock, 'info'),
  'scan_staff.reset_untagged': a('Untagged PINs flagged for replacement', Lock, 'warning'),
  'scan.pin_named_org_cap': a(
    'Named sign-in locked for the day after 300 wrong PINs',
    Lock,
    'danger',
  ),
  'scan_staff.pin_day_limit': a('PIN locked for the day after 50 tries', Lock, 'warning'),
  'scan_staff.pin_only_manager': a('Manager PIN tried on its own', Lock, 'warning'),
  'scanner.pin_only_locked': a('Scanner PIN-only sign-in locked', Lock, 'warning'),
  'scanner.pin_only_paused': a('PIN-only sign-in paused for the hour', Lock, 'warning'),
  'scanner.pin_only_daily_limit': a('PIN-only sign-in paused for the day', Lock, 'warning'),
  'scan.approved_alone': a('Scan approved by its own requester', Lock, 'warning'),
  'scan.pin_only_off': a('PIN-only sign-in turned off', Lock, 'danger'),
};
