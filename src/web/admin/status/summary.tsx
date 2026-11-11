import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { useChangeCount } from '@/web/lib/motion.ts';
import { statusOf } from '@/web/lib/status.ts';
import { Button, StatusPill } from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { assessmentState, type Component, countStates, headline, type State } from './groups.ts';
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
  neutral: { box: 'border-border bg-surface-raised', icon: CircleDashed, text: 'text-fg-muted' },
} as const;

/** The assessment uses only reported checks; configuration alone does not establish health. */
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
  const state = assessmentState(components);
  const tone =
    state === 'failing'
      ? 'danger'
      : state === 'degraded'
        ? 'warning'
        : state === 'verified'
          ? 'success'
          : 'neutral';
  const t = TONE[tone];
  const popped = useChangeCount(tone);
  const counts = countStates(
    components.filter(
      (component) =>
        component.id !== 'connections' ||
        !components.some(
          (other) => other.id.startsWith('connection:') && other.state === component.state,
        ),
    ),
  );
  return (
    <section
      aria-label="Overall status"
      className={cn(
        'flex flex-wrap items-start gap-x-5 gap-y-4 rounded-[24px] border p-5 shadow-elevation-2 sm:p-6',
        t.box,
      )}
    >
      <t.icon
        key={popped}
        aria-hidden
        className={cn('size-9 shrink-0', t.text, popped > 0 && 'wl-state-pop')}
      />
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-xl font-semibold text-fg-strong">{headline(components)}</h2>
        <p className="mt-2 text-xs text-fg-muted" aria-live="polite">
          <span key={checks} className={cn(checks > 0 && 'wl-checked')}>
            {checkedAt > 0 ? (
              <>
                Checked{' '}
                <time dateTime={new Date(checkedAt).toISOString()}>
                  {formatDateTime(checkedAt)}
                </time>
              </>
            ) : (
              'Last checked: unknown'
            )}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          busy="spin"
          loading={rechecking}
          iconStart={<RefreshCw aria-hidden />}
          onClick={onRecheck}
        >
          Recheck
        </Button>
        <Button asChild variant="outline">
          <Link to="/admin/audit">View audit log</Link>
        </Button>
      </div>
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
