import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { useChangeCount } from '@/web/lib/motion.ts';
import { statusOf } from '@/web/lib/status.ts';
import { Button, StatusPill } from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { type Component, countStates, headline, leaves, problems, type State } from './groups.ts';
import './status.css';

const ORDER: State[] = ['failing', 'degraded', 'not_configured', 'configured', 'verified'];

const TONE = {
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
} as const;

/**
 * The banner: what is wrong in one line (leaves only, so one failing connection reads "1
 * connection failing"), when it was checked, and Recheck. Healthy reads "All good" in success.
 */
export function Summary({
  components,
  checkedAt,
  checks,
  rechecking,
  onRecheck,
}: {
  components: readonly Component[];
  checkedAt: number;
  /** Rechecks this visit: each one flashes "Checked". */
  checks: number;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const worst = problems(components)[0]?.state;
  const tone = worst === 'failing' ? 'danger' : worst === 'degraded' ? 'warning' : 'success';
  const t = TONE[tone];
  const popped = useChangeCount(tone);
  const counts = countStates(leaves(components));
  return (
    <section
      aria-label="Overall status"
      className={cn('flex flex-wrap items-center gap-x-5 gap-y-4 rounded-lg border p-5', t.box)}
    >
      <t.icon
        key={popped}
        aria-hidden
        className={cn('size-9 shrink-0', t.text, popped > 0 && 'wl-state-pop')}
      />
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-xl font-semibold text-fg-strong">{headline(components)}</p>
        <p className="mt-0.5 text-sm text-fg" aria-live="polite">
          <span key={checks} className={cn(checks > 0 && 'wl-checked')}>
            Checked{' '}
            <time dateTime={new Date(checkedAt).toISOString()}>{formatDateTime(checkedAt)}</time>
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        busy="spin"
        loading={rechecking}
        iconStart={<RefreshCw aria-hidden />}
        onClick={onRecheck}
      >
        Recheck
      </Button>
      <ul aria-label="Component counts" className="flex basis-full flex-wrap gap-2">
        {ORDER.filter((s) => counts[s] > 0).map((s) => (
          <li key={s}>
            <StatusPill status={s}>
              {counts[s]} {statusOf(s)?.label.toLowerCase()}
            </StatusPill>
          </li>
        ))}
      </ul>
    </section>
  );
}
