import { KeyRound, type LucideIcon, Pause, ShieldCheck, ShieldOff, Tag, UserX } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** What the Polaris ID sync did: access added or taken back, held for the owner, sessions ended. */
export const IDP_ACTIONS = {
  'idp.access_added': a('Polaris ID access added', ShieldCheck, 'success'),
  'idp.access_removed': a('Polaris ID access removed', ShieldOff, 'warning'),
  'idp.access_held': a('Paused in Polaris ID', Pause, 'warning'),
  'idp.sessions_revoked': a('Sessions ended', UserX, 'warning'),
  'idp.account_disabled': a('Polaris ID account disabled', KeyRound, 'warning'),
  'idp.claims_read': a('Polaris ID claims read', Tag, 'neutral'),
  'idp.claims_set': a('Polaris ID claims changed', Tag, 'info'),
  'idp.account_enabled': a('Polaris ID account enabled', KeyRound, 'success'),
};
