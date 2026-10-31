import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  type LucideIcon,
  UserCheck,
  XCircle,
} from 'lucide-react';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

export interface StatusEntry {
  label: string;
  tone: Tone;
  icon: LucideIcon;
}

/** Health vocabulary shared by connections, identities and the status page. */
export const HEALTH_STATUS = {
  verified: { label: 'Verified', tone: 'success', icon: CheckCircle2 },
  configured: { label: 'Configured', tone: 'info', icon: CheckCircle2 },
  degraded: { label: 'Degraded', tone: 'warning', icon: AlertTriangle },
  failing: { label: 'Failing', tone: 'danger', icon: XCircle },
  not_configured: { label: 'Not configured', tone: 'neutral', icon: CircleDashed },
} as const satisfies Record<string, StatusEntry>;

export const PASS_STATUS = {
  active: { label: 'Active', tone: 'success', icon: CheckCircle2 },
  voided: { label: 'Voided', tone: 'neutral', icon: Ban },
  unassigned: { label: 'Unassigned', tone: 'neutral', icon: CircleDashed },
  waiting: { label: 'Waiting', tone: 'warning', icon: Clock },
  owned: { label: 'Owned', tone: 'info', icon: UserCheck },
} as const satisfies Record<string, StatusEntry>;

export const STATUS_VOCAB = { ...HEALTH_STATUS, ...PASS_STATUS } as const;
export type StatusKey = keyof typeof STATUS_VOCAB;

export const TONE_ICON: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: CheckCircle2,
  neutral: CircleDashed,
  accent: CheckCircle2,
};

export function statusOf(key: string): StatusEntry | undefined {
  return (STATUS_VOCAB as Record<string, StatusEntry>)[key];
}
