import {
  CircleCheck,
  KeyRound,
  type LucideIcon,
  ShieldAlert,
  ShieldX,
  Terminal,
} from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Workbench CLI sign-in: a command-line session and the Test key it gets. */
export const CLI_ACTIONS = {
  'cli_session.approved': a('CLI sign-in approved', CircleCheck, 'success'),
  'cli_session.denied': a('CLI sign-in denied', ShieldX, 'warning'),
  'cli_session.account_mismatch': a('CLI sign-in refused, wrong account', ShieldAlert, 'danger'),
  'cli_token.issued': a('CLI key issued', KeyRound, 'success'),
  'cli_token.revoked': a('CLI key ended', Terminal, 'warning'),
};
