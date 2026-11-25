import {
  Code2,
  KeyRound,
  type LucideIcon,
  MailCheck,
  UserMinus,
  UserPlus,
  UserX,
} from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Developer invitations and the access an org vouches for. */
export const DEV_ACCESS_ACTIONS = {
  'developer_invitation.create': a('Developer invited', UserPlus, 'success'),
  'developer_invitation.revoke': a('Developer invitation revoked', UserX, 'warning'),
  'developer_invitation.setup': a('Polaris ID link made', KeyRound, 'info'),
  'developer_invitation.claim': a('Polaris ID account claimed', KeyRound, 'info'),
  'developer_invitation.accept': a('Developer invitation accepted', MailCheck, 'success'),
  'org_invitation.setup': a('Polaris ID link made', KeyRound, 'info'),
  'org_invitation.claim': a('Polaris ID account claimed', KeyRound, 'info'),
  'developer.remove': a('Developer removed', UserMinus, 'warning'),
  'developer.group_removed': a('Developer access removed', Code2, 'info'),
  'developer.sessions_revoked': a('Developer sessions ended', UserX, 'warning'),
};
