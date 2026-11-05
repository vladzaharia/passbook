import {
  AlertCircle,
  ChevronDown,
  FileText,
  type LucideIcon,
  Mail,
  Milestone,
  RefreshCw,
  Send,
  Smartphone,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EventGroup, PassEventDto } from '@/shared/contracts/events.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { cn } from '../../../lib/cn.ts';
import { useInsertHighlight } from '../../../lib/motion.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Handoff,
  IconButton,
  SegmentedControl,
  SkeletonTimeline,
} from '../../../ui/index.ts';
import { RelTime, useNow } from './rel-time.tsx';
import { usePassEvents } from './sync-api.ts';
import { eventCodes, eventDetail, groupEvents, type SyncRow, shortDevice } from './sync-model.ts';

type Filter = EventGroup | 'all';
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'devices', label: 'Devices' },
  { value: 'changes', label: 'Changes' },
] as const;

const EMPTY: Record<Filter, string> = {
  all: 'Nothing recorded yet',
  delivery: 'No pushes or emails yet',
  devices: 'No device activity yet',
  changes: 'No changes yet',
  scans: 'No scans yet',
};

function iconOf(row: SyncRow): LucideIcon {
  const kind = row.events[row.events.length - 1]?.kind ?? '';
  if (row.group) return Send;
  if (kind.startsWith('email.')) return Mail;
  if (kind.startsWith('push.')) return Send;
  if (kind === 'device.log') return FileText;
  if (kind.startsWith('device.') || kind === 'pass.downloaded' || kind === 'page.opened')
    return Smartphone;
  if (row.tone === 'danger') return AlertCircle;
  return Milestone;
}

const DOT = {
  neutral: 'border-border-strong bg-surface-sunken text-fg-muted',
  info: 'border-info-border bg-info-subtle text-info',
  success: 'border-success-border bg-success-subtle text-success',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  danger: 'border-danger-border bg-danger-subtle text-danger',
} as const;

function Child({ e, now }: { e: PassEventDto; now: number }) {
  const detail = eventDetail(e);
  const label =
    e.kind === 'push.sent'
      ? 'Push sent'
      : e.kind === 'push.failed'
        ? 'Push failed'
        : e.kind === 'push.queued'
          ? 'Push queued'
          : e.kind === 'device.fetched'
            ? e.data.step === 'listed'
              ? 'Checked for updates'
              : 'Fetched the pass'
            : e.kind === 'device.unregistered'
              ? 'Unregistered'
              : e.kind.replace('.', ' ');
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-muted">
      <span className="text-fg">{label}</span>
      {e.device ? <span className="font-mono">{shortDevice(e.device)}</span> : null}
      {detail ? <span>{detail}</span> : null}
      {eventCodes(e) ? <span className="font-mono">{eventCodes(e)}</span> : null}
      <span className="ml-auto">
        <RelTime at={e.at} now={now} />
      </span>
    </li>
  );
}

function Row({ row, now, isNew }: { row: SyncRow; now: number; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = iconOf(row);
  const single = row.events.length === 1 ? row.events[0] : undefined;
  const detail = single ? eventDetail(single) : null;
  const expandable = row.group;
  return (
    <li
      data-new={isNew ? '' : undefined}
      className={cn('group relative flex gap-3 pb-4 last:pb-0', isNew && 'wl-tl-new')}
    >
      <span
        aria-hidden
        className="wl-rail-draw absolute top-6 bottom-1 left-[9.5px] w-px bg-border group-last:hidden"
      />
      <span
        aria-hidden
        className={cn(
          'relative inline-flex size-5 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3',
          DOT[row.tone],
        )}
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="text-sm font-medium text-fg-strong">{row.title}</p>
          {single?.device ? (
            <span className="font-mono text-xs text-fg-muted">{shortDevice(single.device)}</span>
          ) : null}
          <span className="ml-auto text-xs text-fg-muted">
            <RelTime at={row.at} now={now} />
          </span>
        </div>
        {detail ? <p className="line-clamp-2 text-xs break-words text-fg-muted">{detail}</p> : null}
        {single && eventCodes(single) ? (
          <details className="text-xs text-fg-muted">
            <summary className="cursor-pointer pointer-coarse:min-h-11">Details</summary>
            <span className="font-mono">{eventCodes(single)}</span>
          </details>
        ) : null}
        {row.facts.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Result">
            {row.facts.map((f) => (
              <li key={f.text}>
                <Badge tone={f.tone}>{f.text}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {expandable ? (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
            >
              {open ? 'Hide' : 'Show'} {row.events.length} events
              <ChevronDown
                aria-hidden
                className={cn('wl-chevron size-3.5', open && 'rotate-180')}
              />
            </button>
            {open ? (
              <ul className="mt-1 grid gap-1 border-l border-border pl-3">
                {row.events.map((e) => (
                  <Child key={e.id} e={e} now={now} />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

/** Why didn't my pass update? The ledger grouped by version, newest first. */
export function SyncTab({ pass, active }: { pass: PassDetailDto; active: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const query = usePassEvents(pass.id, filter, active);
  const now = useNow();
  const events = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const rows = useMemo(() => groupEvents(events), [events]);
  const fresh = useInsertHighlight(rows.map((r) => r.id));
  return (
    <Card className="min-w-0">
      <CardHeader
        title="Sync log"
        actions={
          <IconButton
            size="sm"
            label="Reload sync log"
            data-busy={query.isFetching ? 'spin' : undefined}
            icon={<RefreshCw aria-hidden />}
            onClick={() => void query.refetch()}
          />
        }
      />
      <CardBody className="grid gap-4">
        <SegmentedControl label="Show" options={FILTERS} value={filter} onValueChange={setFilter} />
        {query.isError ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Handoff
            loading={query.isPending}
            skeleton={<SkeletonTimeline label="Loading sync log" />}
          >
            {rows.length === 0 ? (
              <EmptyState inline art="activity" title={EMPTY[filter]} />
            ) : (
              <ol aria-label="Sync log" className="flex flex-col">
                {rows.map((row) => (
                  <Row key={row.id} row={row} now={now} isNew={fresh.has(row.id)} />
                ))}
              </ol>
            )}
            {query.hasNextPage ? (
              <div>
                <Button
                  variant="outline"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Load older
                </Button>
              </div>
            ) : null}
          </Handoff>
        )}
      </CardBody>
    </Card>
  );
}
