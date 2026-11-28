import { Clock, type LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import { PASS_RUN_ACTIONS } from './actions-passes.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });
const rotate = ACTION_ICON.rotate;
const key = ACTION_ICON.pushKey;

/** Identity expiry, managed identity runs and Google issuer and key events. */
export const IDENTITY_RUN_ACTIONS = {
  ...PASS_RUN_ACTIONS,
  'identity.expired': a('Identity expired', Clock, 'danger'),
  'identity.expiring': a('Identity expiring', Clock, 'warning'),
  'identity.platform_default_changed': a('Default identity changed', rotate, 'info'),
  'identity.provision_requested': a('Identity requested', rotate, 'info'),
  'identity.pass_type_created': a('Pass type ready', rotate, 'success'),
  'identity.certificate_issued': a('Certificate issued', rotate, 'success'),
  'identity.provisioned': a('Identity ready', rotate, 'success'),
  'identity.rotated': a('Certificate renewed', rotate, 'success'),
  'identity.rotation_failed': a('Renewal failed', Clock, 'danger'),
  'identity.rotation_overdue': a('Renewal overdue', Clock, 'danger'),
  'identity.provision_failed': a('Identity setup failed', Clock, 'danger'),
  'identity.renew_requested': a('Renewal requested', rotate, 'info'),
  'identity.certificate_revoke_requested': a('Revoke requested', rotate, 'warning'),
  'identity.certificate_revoked': a('Certificate revoked', rotate, 'warning'),
  'identity.run_retry': a('Run retried', rotate, 'info'),
  'identity.run_cancel': a('Run cancelled', rotate, 'warning'),
  'identity.move_started': a('Passes moving', rotate, 'info'),
  'identity.move_armed': a('Old pass timer started', rotate, 'info'),
  'wallet.google_issuer_requested': a('Google issuer requested', key, 'info'),
  'wallet.google_issuer_entered': a('Google issuer entered', key, 'success'),
  'wallet.google_issuer_created': a('Google issuer created', key, 'success'),
  'wallet.google_key_rotated': a('Google key rotated', key, 'success'),
  'wallet.uncertain_recheck': a('Uncertain updates rechecked', rotate, 'info'),
  'wallet.key_unknown': a('Unknown Google key', key, 'danger'),
};
