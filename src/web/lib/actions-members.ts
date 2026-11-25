import { type LucideIcon, MailPlus, UserCog } from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Member changes that replace a row: a resent invitation and a role change. */
export const MEMBER_ACTIONS = {
  'org_invitation.resend': a('Invitation resent', MailPlus, 'info'),
  'org_membership.roles': a('Member roles changed', UserCog, 'info'),
};
