import { Link2, type LucideIcon, ShieldAlert, ShieldX } from 'lucide-react';
import { IDP_ACTIONS } from './actions-idp.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Sign-in events: break-glass, denials, linked methods and email ownership, and what the Polaris ID sync did. */
export const AUTH_ACTIONS = {
  'auth.breakglass_failed': a('Break-glass sign-in failed', ShieldAlert, 'danger'),
  'auth.breakglass_used': a('Break-glass sign-in', ShieldAlert, 'warning'),
  'auth.denied': a('Access denied', ShieldX, 'warning'),
  'api_key.refused': a('Platform key refused', ShieldX, 'warning'),
  'auth.identity_linked': a('Sign-in method linked', Link2, 'info'),
  'auth.identity_linked_moved_primary': a(
    'Polaris ID linked after email change',
    ShieldAlert,
    'warning',
  ),
  'auth.primary_email_unproven': a('Unproven email released', ShieldAlert, 'warning'),
  'auth.oidc_email_not_primary': a('Polaris ID email not primary', ShieldAlert, 'warning'),
  ...IDP_ACTIONS,
};
