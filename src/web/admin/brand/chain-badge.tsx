import { AlertCircle, Check, Lock, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import type { ChannelLevel } from '@/shared/contracts/channels.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { cn } from '@/web/lib/cn.ts';

const WORDS = PASS_SETUP_COPY.levels;

function Pie({ share }: { share: number }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5">
      <circle
        cx="8"
        cy="8"
        r="6"
        className="fill-none stroke-current opacity-40"
        strokeWidth="1.5"
      />
      <circle
        cx="8"
        cy="8"
        r="3"
        className="fill-none stroke-current"
        strokeWidth="6"
        strokeDasharray={`${share * 18.85} 18.85`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

const TONE = {
  ok: 'border-success-border bg-success-subtle text-success',
  partial: 'border-warning-border bg-warning-subtle text-warning',
  needs: 'border-warning-border bg-warning-subtle text-warning',
  off: 'border-border-strong bg-state-hover-tint text-fg-muted',
  locked: 'border-dashed border-border-strong bg-transparent text-fg-muted',
  /** After the stopping level: quiet by colour, never by opacity, so the text keeps its contrast. */
  after: 'border-dashed border-border bg-transparent text-fg-muted',
} as const;

function Pill({
  level,
  stop,
  dim,
  label,
  share,
}: {
  level: ChannelLevel;
  stop: boolean;
  dim: boolean;
  label: string;
  share?: number;
}) {
  const icon: ReactNode =
    level.state === 'ok' ? (
      <Check aria-hidden />
    ) : level.state === 'locked' ? (
      <Lock aria-hidden />
    ) : level.state === 'off' ? (
      <X aria-hidden />
    ) : level.state === 'needs' ? (
      <AlertCircle aria-hidden />
    ) : (
      <Pie share={share ?? 0.5} />
    );
  return (
    <span
      data-level={level.level}
      data-state={level.state}
      data-stop={stop || undefined}
      data-after={dim || undefined}
      aria-current={stop ? 'step' : undefined}
      className={cn(
        'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs max-sm:gap-1 max-sm:px-2 font-medium whitespace-nowrap [&_svg]:size-3.5',
        TONE[dim ? 'after' : level.state],
        stop && 'ring-2 ring-border-strong ring-offset-1 ring-offset-surface-raised',
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * The chain an admin reads: PassBook › Plan › Organization › Templates n/m. The first level that
 * stops the channel is ringed, and the levels after it dim. It is the one inheritance component;
 * the template, pass and platform pages draw the same row.
 */
export function ChainBadge({
  levels,
  templates,
}: {
  levels: readonly ChannelLevel[];
  /** The org page's Templates n/m aggregate; absent on a template or pass, where the level is its own. */
  templates?: { on: number; total: number } | undefined;
}) {
  const stop = stoppingLevel(levels);
  const at = stop ? levels.indexOf(stop) : -1;
  return (
    <ol aria-label="Chain" className="wl-stagger flex flex-wrap items-center gap-y-2">
      {levels.map((level, i) => {
        const aggregate = level.level === 'template' && templates !== undefined;
        const label = aggregate
          ? scanLine(PASS_SETUP_COPY.templatesLevel, templates)
          : WORDS[level.level];
        return (
          <li key={level.level} className="inline-flex items-center" style={{ '--i': i } as never}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'h-px w-3 max-sm:w-1.5',
                  at !== -1 && i > at ? 'bg-border' : 'bg-border-strong',
                )}
              />
            ) : null}
            <Pill
              level={level}
              stop={i === at}
              dim={at !== -1 && i > at}
              label={label}
              {...(aggregate && templates.total > 0
                ? { share: templates.on / templates.total }
                : {})}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** The lock pill on a channel row: names the PassBook or Plan level that stops it. */
export function LockPill({ levels }: { levels: readonly ChannelLevel[] }) {
  const stop = stoppingLevel(levels);
  if (stop?.state !== 'locked') return null;
  return (
    <span
      className="inline-flex min-h-6 items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-xs font-medium text-fg-muted [&_svg]:size-3"
      title={scanLine(PASS_SETUP_COPY.page.lockedBy, { level: WORDS[stop.level] })}
    >
      <Lock aria-hidden />
      {WORDS[stop.level]}
    </span>
  );
}
