import { Clock, type LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });
const rotate = ACTION_ICON.rotate;

/** Managed identity runs: setup and certificate renewal. */
export const IDENTITY_RUN_ACTIONS = {
  'identity.provision_requested': a('Identity requested', rotate, 'info'),
  'identity.pass_type_created': a('Pass type ready', rotate, 'success'),
  'identity.certificate_issued': a('Certificate issued', rotate, 'success'),
  'identity.provisioned': a('Identity ready', rotate, 'success'),
  'identity.rotated': a('Certificate renewed', rotate, 'success'),
  'identity.rotation_failed': a('Renewal failed', Clock, 'danger'),
  'identity.rotation_overdue': a('Renewal overdue', Clock, 'danger'),
  'identity.provision_failed': a('Identity setup failed', Clock, 'danger'),
};
