import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  CheckCircle2,
  CircleDashed,
  CirclePause,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  type LucideIcon,
  Shield,
  Smartphone,
  Star,
  Upload,
  User,
  UserCheck,
  WalletCards,
  XCircle,
} from 'lucide-react';
import type { z } from 'zod';
import type { SignInMethodSchema } from '@/shared/contracts/users.ts';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

export interface StatusEntry {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** The icon spins while the state lasts (kept under reduced motion: it carries state). */
  spin?: boolean;
  /** One sentence for a tooltip where the label alone is ambiguous. */
  hint?: string;
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
  /** Taken off holders' devices: Wallet files it under Expired passes. */
  removed: { label: 'Removed', tone: 'neutral', icon: EyeOff },
  /** On the holder's own list: the pass is already in a Wallet. */
  in_wallet: { label: 'In Wallet', tone: 'success', icon: WalletCards },
} as const satisfies Record<string, StatusEntry>;

/** Where a registered device stands against the pass's current version (events ledger). */
export const DEVICE_SYNC_STATUS = {
  device_current: { label: 'Up to date', tone: 'success', icon: CheckCircle2 },
  device_waiting: {
    label: 'Waiting',
    tone: 'info',
    icon: Clock,
    hint: 'Pushed, and the device has not fetched the new version yet.',
  },
  push_failing: {
    label: 'Push failing',
    tone: 'danger',
    icon: XCircle,
    hint: 'Apple rejected the last push to this device.',
  },
  device_removed: {
    label: 'Removed from device',
    tone: 'neutral',
    icon: Ban,
    hint: 'The device unregistered the pass.',
  },
  device_unknown: { label: 'No activity', tone: 'neutral', icon: CircleDashed },
  /** After a remove: the device fetched the final version, or the holder deleted the pass. */
  removal_fetched: { label: 'Removed', tone: 'success', icon: CheckCircle2 },
  removal_deleted: { label: 'Deleted by holder', tone: 'success', icon: CheckCircle2 },
  removal_pending: { label: 'Waiting', tone: 'info', icon: Clock },
} as const satisfies Record<string, StatusEntry>;

/** An organization paused by an admin: its passes stop updating until reactivated. */
export const ORG_STATUS = {
  suspended: { label: 'Suspended', tone: 'warning', icon: CirclePause },
} as const satisfies Record<string, StatusEntry>;

/** An account email that has not proven it reaches its owner. */
export const EMAIL_STATUS = {
  unverified: { label: 'Not verified', tone: 'neutral', icon: CircleDashed },
  /** A verification link is on its way. */
  check_inbox: { label: 'Check your inbox', tone: 'neutral', icon: Clock },
} as const satisfies Record<string, StatusEntry>;

/** Holder states: owned, waiting, unassigned on the wire. */
export const HOLDER_STATUS = {
  owned: {
    label: 'Claimed',
    tone: 'success',
    icon: UserCheck,
    hint: 'The holder signed in and has this pass.',
  },
  waiting: {
    label: 'Not claimed',
    tone: 'neutral',
    icon: Clock,
    hint: 'Sent to an email. Nobody has signed in for it yet.',
  },
  unassigned: {
    label: 'No holder',
    tone: 'neutral',
    icon: CircleDashed,
    hint: 'No email is attached to this pass.',
  },
} as const satisfies Record<string, StatusEntry>;

/** Template origin: built into the platform (baked on the wire) or uploaded. */
export const ORIGIN_STATUS = {
  builtin: { label: 'Built-in', tone: 'neutral', icon: Lock },
  baked: { label: 'Built-in', tone: 'neutral', icon: Lock },
  uploaded: { label: 'Uploaded', tone: 'neutral', icon: Upload },
} as const satisfies Record<string, StatusEntry>;

export const ROLE_STATUS = {
  admin: { label: 'Admin', tone: 'neutral', icon: Shield },
  user: { label: 'User', tone: 'neutral', icon: User },
} as const satisfies Record<string, StatusEntry>;

/** Delivery outbox and workflow/connection run states. */
export const RUN_STATUS = {
  pending: { label: 'Pending', tone: 'neutral', icon: Clock },
  enqueued: { label: 'Queued', tone: 'neutral', icon: Clock },
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  processing: { label: 'Processing', tone: 'info', icon: Loader2, spin: true },
  running: { label: 'Running', tone: 'info', icon: Loader2, spin: true },
  sent: { label: 'Sent', tone: 'success', icon: CheckCircle2 },
  complete: { label: 'Complete', tone: 'success', icon: CheckCircle2 },
  healthy: { label: 'Healthy', tone: 'success', icon: CheckCircle2 },
  all_good: { label: 'All good', tone: 'success', icon: CheckCircle2 },
  no_recent_run: { label: 'No recent run', tone: 'warning', icon: Clock },
  partial: { label: 'Partial', tone: 'warning', icon: AlertTriangle },
  expiring: { label: 'Expiring', tone: 'warning', icon: AlertTriangle },
  terminated: { label: 'Terminated', tone: 'warning', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  errored: { label: 'Errored', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  no_devices: { label: 'No devices', tone: 'neutral', icon: CircleDashed },
  revoked: { label: 'Revoked', tone: 'neutral', icon: Ban },
  disabled: { label: 'Disabled', tone: 'neutral', icon: Ban },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDashed },
  not_checked: { label: 'Not checked', tone: 'neutral', icon: CircleDashed },
} as const satisfies Record<string, StatusEntry>;

/** Messages and scheduled changes; sent, partial, failed and cancelled come from RUN_STATUS. */
export const BROADCAST_STATUS = {
  draft: { label: 'Draft', tone: 'neutral', icon: CircleDashed },
  scheduled: { label: 'Scheduled', tone: 'info', icon: Clock },
  sending: { label: 'Sending', tone: 'info', icon: Loader2, spin: true },
} as const satisfies Record<string, StatusEntry>;

/**
 * Selection or primary markers: attributes, not health, so neutral (teal is for actions and
 * links); the icon tells them apart. this_device takes the device's icon (StatusPill icon prop).
 */
export const MARKER_STATUS = {
  primary: { label: 'Primary', tone: 'neutral', icon: Star },
  showing: { label: 'Showing', tone: 'neutral', icon: Eye },
  this_device: { label: 'This device', tone: 'neutral', icon: Smartphone },
  default: { label: 'Default', tone: 'neutral', icon: BadgeCheck },
} as const satisfies Record<string, StatusEntry>;

export const STATUS_VOCAB = {
  ...HEALTH_STATUS,
  ...PASS_STATUS,
  ...DEVICE_SYNC_STATUS,
  ...ORG_STATUS,
  ...EMAIL_STATUS,
  ...HOLDER_STATUS,
  ...ORIGIN_STATUS,
  ...ROLE_STATUS,
  ...RUN_STATUS,
  ...BROADCAST_STATUS,
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

type SignInMethod = z.infer<typeof SignInMethodSchema>;

/**
 * How someone signs in. Label by context: a session was "Signed in with" one method; a user
 * "Signs in with" the methods on their account.
 */
export const SIGN_IN_METHOD: Record<SignInMethod, string> = {
  oidc: 'Polaris ID',
  magic_link: 'Email link',
  breakglass: 'Break-glass',
};
export const signInMethodLabel = (key: string): string =>
  SIGN_IN_METHOD[key as SignInMethod] ?? humanizeStatus(key);

export const causeLabel = (key: string): string => CAUSE_LABEL[key] ?? humanizeStatus(key);
export const deliveryKindLabel = (key: string): string =>
  DELIVERY_KIND_LABEL[key] ?? humanizeStatus(key);
