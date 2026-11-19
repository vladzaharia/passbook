import {
  Check,
  CircleX,
  DoorOpen,
  Hourglass,
  Info,
  type LucideIcon,
  ScanLine,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { CUSTOMER_COPY } from '../../shared/copy/scan-customer.ts';

/** Every state a customer screen shows. Each has its own colour, icon and words. */
export type StageTone =
  | 'ready'
  | 'checking'
  | 'accepted'
  | 'checkedOut'
  | 'rejected'
  | 'failed'
  | 'attention'
  | 'review'
  | 'undone';

export type StageSignal = 'brand' | 'success' | 'info' | 'danger' | 'warning';

export interface StageStyle {
  signal: StageSignal;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  hint: string;
}

export const STAGE: Record<StageTone, StageStyle> = {
  ready: {
    signal: 'brand',
    icon: ScanLine,
    eyebrow: 'Welcome',
    title: CUSTOMER_COPY.welcome,
    hint: '',
  },
  checking: {
    signal: 'brand',
    icon: Hourglass,
    eyebrow: 'One moment',
    title: 'Checking pass',
    hint: '',
  },
  accepted: {
    signal: 'success',
    icon: Check,
    eyebrow: 'Welcome',
    title: "You're checked in",
    hint: '',
  },
  checkedOut: {
    signal: 'info',
    icon: DoorOpen,
    eyebrow: 'See you soon',
    title: "You're checked out",
    hint: '',
  },
  rejected: {
    signal: 'danger',
    icon: CircleX,
    eyebrow: 'Pass not accepted',
    title: 'Please see staff',
    hint: '',
  },
  failed: {
    signal: 'warning',
    icon: TriangleAlert,
    eyebrow: "Couldn't check",
    title: 'Try again or see staff',
    hint: '',
  },
  attention: {
    signal: 'warning',
    icon: TriangleAlert,
    eyebrow: 'One more check',
    title: 'Please see staff',
    hint: '',
  },
  review: { signal: 'brand', icon: Info, eyebrow: 'One moment', title: 'Checking pass', hint: '' },
  undone: { signal: 'info', icon: Undo2, eyebrow: 'Updated', title: 'Entry undone', hint: '' },
};

/** The native bridge's status words onto a tone. */
export function toneOfStatus(status: string): StageTone {
  return status in STAGE ? (status as StageTone) : 'ready';
}
