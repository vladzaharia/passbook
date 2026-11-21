import type { LucideIcon } from 'lucide-react';
import { Clock, MapPin, Pencil, Smartphone, Ticket, Users } from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { useChangeCount } from '@/web/lib/motion.ts';
import { Buddy, Button, EntityArt } from '@/web/ui/index.ts';
import type { StepId } from './draft.ts';
import type { LineKey, SummaryLine } from './summary.ts';
import './setup.css';

const ICON: Record<LineKey, LucideIcon> = {
  admits: Ticket,
  where: MapPin,
  when: Clock,
  scanners: Users,
  devices: Smartphone,
};

function Line({
  line,
  dim,
  onEdit,
}: {
  line: SummaryLine;
  dim: boolean;
  onEdit?: ((step: StepId) => void) | undefined;
}) {
  const Icon = ICON[line.key];
  // A changed line flashes once; the first render never does.
  const changed = useChangeCount(`${line.value}|${line.detail.join('|')}`);
  return (
    <li
      key={changed}
      data-line={line.key}
      data-dim={dim || undefined}
      className={cn(
        'flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0',
        changed > 0 && 'wl-sum-flash',
      )}
    >
      <Icon
        aria-hidden
        className={cn('mt-0.5 size-4 shrink-0', dim ? 'text-fg-subtle' : 'text-fg-muted')}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-xs', dim ? 'text-fg-subtle' : 'text-fg-muted')}>{line.label}</p>
        <p className={cn('text-sm', dim ? 'text-fg-subtle' : 'font-medium text-fg-strong')}>
          {dim ? '—' : (line.value ?? '—')}
        </p>
        {dim
          ? null
          : line.detail.map((d) => (
              <p key={d} className="text-xs text-fg-muted">
                {d}
              </p>
            ))}
      </div>
      {onEdit ? (
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Pencil aria-hidden />}
          aria-label={`Edit ${line.label}`}
          onClick={() => onEdit(line.step)}
        >
          Edit
        </Button>
      ) : null}
    </li>
  );
}

/**
 * The door as the answers make it, in one order everywhere (Who gets in, Where, When, Who scans,
 * Devices). Lines for steps not reached stay dimmed and fill in as they are answered; with
 * `onEdit` each line has an Edit button (Review).
 */
export function DoorSummary({
  name,
  lines,
  reached = Number.POSITIVE_INFINITY,
  stepIndex,
  onEdit,
  scene,
}: {
  name: string;
  lines: readonly SummaryLine[];
  /** The furthest step index the admin has opened; later steps read dimmed. */
  reached?: number;
  stepIndex?: (step: StepId) => number;
  onEdit?: (step: StepId) => void;
  scene?: 'peek';
}) {
  return (
    <section aria-label="Door summary" data-art-host="" className="relative mt-[4.5rem] min-w-0">
      <div aria-hidden className="relative h-0 w-full">
        <Buddy
          at="start"
          size="sm"
          {...(scene ? { scene } : {})}
          prop={<EntityArt name="scanner" size="sm" />}
        />
      </div>
      <div className="rounded-lg border border-border bg-surface-raised shadow-elevation-1">
        <h3 className="px-4 pt-4 pb-2 text-sm font-semibold text-fg-strong">
          {name || 'New door'}
        </h3>
        <ul>
          {lines.map((l) => (
            <Line
              key={l.key}
              line={l}
              dim={(stepIndex?.(l.step) ?? 0) > reached || l.value === null}
              onEdit={onEdit}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
