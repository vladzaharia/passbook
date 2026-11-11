import { Link } from '@tanstack/react-router';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cn } from '../../lib/cn.ts';
import { Card, CardBody, CardHeader, CountUp } from '../../ui/index.ts';
import type { ItemOutcome } from './api.ts';
import { BroadcastProgress } from './progress.tsx';

const STATE_ACTS = {
  sending: { mood: 'happy', scene: 'count' },
  sent: { mood: 'happy', scene: 'cheer' },
  partial: { mood: 'sad', scene: 'mend' },
  failed: { mood: 'sad', scene: 'tear' },
} as const;

function Stat({
  label,
  value,
  hint,
  filter,
  current,
  id,
}: {
  label: string;
  value: number;
  hint?: string;
  /** The Passes list this count opens: undefined for none, null for every pass. */
  filter?: ItemOutcome | null;
  current?: ItemOutcome | undefined;
  id: string;
}) {
  const number = <CountUp value={value} className="text-xl font-semibold" />;
  const active = filter !== undefined && (filter ?? undefined) === current;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="m-0">
        {filter === undefined ? (
          <span className="text-fg-strong">{number}</span>
        ) : (
          <Link
            to="/admin/messages/$broadcastId"
            params={{ broadcastId: id }}
            search={{ outcome: filter ?? undefined }}
            replace
            resetScroll={false}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'inline-flex min-h-6 items-center rounded-sm underline-offset-2 hover:underline',
              active ? 'text-fg-strong underline' : 'text-accent-fg',
            )}
          >
            {number}
          </Link>
        )}
      </dd>
      {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
    </div>
  );
}

/**
 * Progress and the counts. Each count opens the Passes list below filtered to it. The buddy has its
 * seat on the card in every state, so a state change never moves the layout; it acts out how the run
 * is going.
 */
export function Counts({ b, outcome }: { b: BroadcastDto; outcome: ItemOutcome | undefined }) {
  const c = b.counts;
  const act = b.state in STATE_ACTS ? STATE_ACTS[b.state as keyof typeof STATE_ACTS] : undefined;
  return (
    <Card>
      <CardHeader title="Progress" />
      <CardBody className="flex flex-col gap-4">
        {act ? (
          <>
            <BroadcastProgress broadcast={b} />
            <dl className="m-0 grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat id={b.id} label="Targeted" value={c.targeted} filter={null} current={outcome} />
              <Stat
                id={b.id}
                label="Updated"
                value={c.updated}
                filter="updated"
                current={outcome}
              />
              <Stat
                id={b.id}
                label="Unchanged"
                value={c.unchanged}
                filter="unchanged"
                current={outcome}
              />
              <Stat
                id={b.id}
                label="Silent (daily limit)"
                value={c.overBudget}
                hint={c.overBudget ? 'Updated without a notification' : ''}
              />
              <Stat id={b.id} label="Failed" value={c.failed} filter="failed" current={outcome} />
            </dl>
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            {b.state === 'cancelled'
              ? 'Cancelled before it started.'
              : 'Counts appear once it starts.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
