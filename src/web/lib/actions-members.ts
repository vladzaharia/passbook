import {
  type LucideIcon,
  MailCheck,
  MailPlus,
  MailX,
  UserCheck,
  UserCog,
  UserMinus,
} from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Invitations and memberships: sent, accepted, resent, revoked, joined, changed, removed. */
export const MEMBER_ACTIONS = {
  'org_invitation.accept': a('Invitation accepted', MailCheck, 'success'),
  'org_invitation.create': a('Member invited', MailPlus, 'success'),
  'org_invitation.resend': a('Invitation resent', MailPlus, 'info'),
  'org_invitation.revoke': a('Invitation revoked', MailX, 'warning'),
  'org_membership.create': a('Member joined', UserCheck, 'success'),
  'org_membership.revoke': a('Member removed', UserMinus, 'warning'),
  'org_membership.roles': a('Member roles changed', UserCog, 'info'),
};
