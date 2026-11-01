import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader,
  type LucideIcon,
  Star,
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
  waiting: { label: 'Waiting', tone: 'neutral', icon: Clock },
  owned: { label: 'Owned', tone: 'info', icon: UserCheck },
} as const satisfies Record<string, StatusEntry>;

/** Delivery outbox and workflow/connection run states. */
export const RUN_STATUS = {
  pending: { label: 'Pending', tone: 'neutral', icon: Clock },
  enqueued: { label: 'Queued', tone: 'neutral', icon: Clock },
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  processing: { label: 'Processing', tone: 'info', icon: Loader },
  running: { label: 'Running', tone: 'info', icon: Loader },
  sent: { label: 'Sent', tone: 'success', icon: CheckCircle2 },
  complete: { label: 'Complete', tone: 'success', icon: CheckCircle2 },
  healthy: { label: 'Healthy', tone: 'success', icon: CheckCircle2 },
  partial: { label: 'Partial', tone: 'warning', icon: AlertTriangle },
  expiring: { label: 'Expiring', tone: 'warning', icon: AlertTriangle },
  terminated: { label: 'Terminated', tone: 'warning', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  errored: { label: 'Errored', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  revoked: { label: 'Revoked', tone: 'neutral', icon: Ban },
  disabled: { label: 'Disabled', tone: 'neutral', icon: Ban },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDashed },
  not_checked: { label: 'Not checked', tone: 'neutral', icon: CircleDashed },
} as const satisfies Record<string, StatusEntry>;

/** Selection or primary markers. */
export const MARKER_STATUS = {
  primary: { label: 'Primary', tone: 'accent', icon: Star },
  showing: { label: 'Showing', tone: 'accent', icon: CheckCircle2 },
  this_device: { label: 'This device', tone: 'accent', icon: CheckCircle2 },
  default: { label: 'Default', tone: 'accent', icon: CheckCircle2 },
} as const satisfies Record<string, StatusEntry>;

export const STATUS_VOCAB = {
  ...HEALTH_STATUS,
  ...PASS_STATUS,
  ...RUN_STATUS,
  ...MARKER_STATUS,
} as const;
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

/** 'not_checked' to 'Not checked'; never show a raw enum. */
export function humanizeStatus(key: string): string {
  const text = key.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const CAUSE_LABEL: Record<string, string> = {
  create: 'Created',
  admin: 'Admin edit',
  api: 'API',
  connection: 'Connection sync',
  user_refresh: 'Holder refresh',
  template_upgrade: 'Template upgrade',
  resign: 'Re-signed',
};

const DELIVERY_KIND_LABEL: Record<string, string> = { push: 'Push', email: 'Email' };

export const causeLabel = (key: string): string => CAUSE_LABEL[key] ?? humanizeStatus(key);
export const deliveryKindLabel = (key: string): string =>
  DELIVERY_KIND_LABEL[key] ?? humanizeStatus(key);
