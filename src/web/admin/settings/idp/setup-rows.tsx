import { ArrowUpRight, Clock } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { SetupItem } from '@/shared/contracts/idp-setup.ts';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { PROBLEM_LABEL } from '@/shared/copy/idp-platform.ts';
import {
  SETUP_LABEL,
  SETUP_REASON,
  SETUP_ROW_STATE,
  setupRunbook,
} from '@/shared/copy/idp-setup.ts';
import { useChangeCount } from '@/web/lib/change-count.ts';
import { cn } from '@/web/lib/cn.ts';
import { humanizeStatus } from '@/web/lib/status.ts';
import { Button, StatusPill, StepMarker, type StepMarkerState } from '@/web/ui/index.ts';

const roleName = (role: string): string =>
  (IDP_COPY.role as Record<string, string>)[role] ?? humanizeStatus(role);

/** One sentence for why an item waits or stops; nothing when it is simply done or still to do. */
export function reasonText(item: SetupItem): string | null {
  if (item.status === 'done') return null;
  const [word = '', detail] = (item.reason ?? '').split(':');
  if (!word) return null;
  if (word === 'after') {
    const dep = SETUP_LABEL[detail as keyof typeof SETUP_LABEL];
    return dep ? `After ${dep}.` : null;
  }
  const base = SETUP_REASON[word];
  if (base && detail) return `${roleName(detail)} ${base}`;
  if (base) return base;
  if (item.key === 'polaris_settings') {
    const more = (item.counts?.reasons ?? 1) - 1;
    const text = PROBLEM_LABEL[word] ?? `${humanizeStatus(word)}.`;
    return more > 0 ? `${text} ${more} more.` : text;
  }
  return `${humanizeStatus(word)}.`;
}

const STATE: Record<SetupItem['status'], { marker: StepMarkerState; word: string }> = {
  done: { marker: 'done', word: 'Done' },
  needed: { marker: 'todo', word: 'Needed' },
  blocked: { marker: 'invalid', word: 'Blocked' },
};

function pillOf(item: SetupItem) {
  if (item.key === 'write_mode' && item.note)
    return (
      <StatusPill status={`idp_${item.note}`} tone={item.note === 'live' ? 'success' : 'info'} />
    );
  const waits = item.status === 'needed' && item.reason?.startsWith('after:');
  if (waits)
    return (
      <StatusPill status="setup_after" tone="neutral" icon={Clock}>
        Waiting
      </StatusPill>
    );
  const tone =
    item.status === 'done' ? 'success' : item.status === 'blocked' ? 'danger' : 'warning';
  return (
    <StatusPill status={`setup_${item.status}`} tone={tone}>
      {STATE[item.status].word}
    </StatusPill>
  );
}

/** Roles and alias groups with what PassBook did to each: aliases are only ever allowed, never placed. */
function GroupRows({ item }: { item: SetupItem }) {
  if (!item.rows?.length) return null;
  return (
    <ul aria-label={`${SETUP_LABEL[item.key]} detail`} className="mt-1.5 flex flex-wrap gap-1.5">
      {item.rows.map((row) => (
        <li
          key={row.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-fg"
        >
          <code className="font-mono">{row.key}</code>
          <span className={cn('text-fg-muted', row.state === 'needed' && 'text-warning')}>
            {SETUP_ROW_STATE[row.state]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One matrix item: marker, label, state, the reason, its groups and, for an owner step, its runbook. */
export function SetupRow({ item, n }: { item: SetupItem; n: number }) {
  const changed = useChangeCount(item.status);
  const reason = reasonText(item);
  const runbook =
    item.owner || item.key === 'write_mode' ? setupRunbook(item.key, item.reason) : null;
  const live = item.key === 'write_mode' && item.note === 'live';
  return (
    <li
      className="flex min-h-11 items-start gap-3 py-3 first:pt-0 last:pb-0 @max-[16rem]:flex-wrap"
      style={{ '--i': n } as CSSProperties}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        <StepMarker
          size="sm"
          n={n + 1}
          state={STATE[item.status].marker}
          fresh={item.status === 'done' && changed > 0}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-x-2 gap-y-1 @max-[24rem]:flex-wrap">
          <span className="min-w-0 text-sm text-fg-strong">{SETUP_LABEL[item.key]}</span>
          <span className="flex shrink-0 items-center gap-1.5">{pillOf(item)}</span>
        </div>
        {reason ? <p className="text-xs text-fg-muted">{reason}</p> : null}
        <GroupRows item={item} />
      </div>
      {runbook && !live ? (
        <div className="ml-auto flex shrink-0 items-center">
          <Button asChild variant="ghost" size="sm" iconEnd={<ArrowUpRight aria-hidden />}>
            <a
              href={runbook}
              target="_blank"
              rel="noreferrer"
              aria-label={`Runbook for ${SETUP_LABEL[item.key]}`}
            >
              Runbook
            </a>
          </Button>
        </div>
      ) : null}
    </li>
  );
}
