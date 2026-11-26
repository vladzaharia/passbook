import {
  KeyRound,
  type LucideIcon,
  Pause,
  ShieldCheck,
  ShieldOff,
  Tag,
  Users,
  UserX,
} from 'lucide-react';
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
  'idp.group_create': a('Polaris ID group created', Users, 'success'),
  'idp.group_update': a('Polaris ID group renamed', Users, 'info'),
  'idp.group_delete': a('Polaris ID group deleted', Users, 'warning'),
  'idp.group_rule': a('Polaris ID group rule changed', Users, 'info'),
  'idp.group_member': a('Polaris ID group member changed', Users, 'info'),
  'idp.account_enabled': a('Polaris ID account enabled', KeyRound, 'success'),
};
