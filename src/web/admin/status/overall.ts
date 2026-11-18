import { AlertTriangle, CheckCircle2, CircleDashed, type LucideIcon, XCircle } from 'lucide-react';
import { statusOf } from '@/web/lib/status.ts';
import { assessmentState, type Component, countStates, type State } from './groups.ts';

export type OverallTone = 'danger' | 'warning' | 'success' | 'neutral';

export const OVERALL_TONE: Record<OverallTone, { box: string; icon: LucideIcon; text: string }> = {
  danger: { box: 'border-danger-border bg-danger-subtle', icon: XCircle, text: 'text-danger' },
  warning: {
    box: 'border-warning-border bg-warning-subtle',
    icon: AlertTriangle,
    text: 'text-warning',
  },
  success: {
    box: 'border-success-border bg-success-subtle',
    icon: CheckCircle2,
    text: 'text-success',
  },
  neutral: { box: 'border-border bg-surface-raised', icon: CircleDashed, text: 'text-fg-muted' },
};

export const STATE_ORDER: State[] = [
  'failing',
  'degraded',
  'not_configured',
  'configured',
  'not_in_use',
  'verified',
];

export function overallTone(components: readonly Pick<Component, 'state'>[]): OverallTone {
  const state = assessmentState(components);
  return state === 'failing'
    ? 'danger'
    : state === 'degraded'
      ? 'warning'
      : state === 'verified'
        ? 'success'
        : 'neutral';
}

/** "13 verified · 3 set up · 1 not in use": the breakdown behind the headline. */
export function breakdown(components: readonly Pick<Component, 'state'>[]): string {
  const counts = countStates(components);
  return STATE_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${statusOf(s)?.label.toLowerCase()}`)
    .join(' · ');
}
