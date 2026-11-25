import { Link } from '@tanstack/react-router';
import { Plus, Tablet } from 'lucide-react';
import { useEffect } from 'react';
import type { z } from 'zod';
import type { Mode } from '@/shared/contracts/common.ts';
import type { TagScannerSchema } from '@/shared/contracts/nfc-tag-enrollments.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { formatAgo } from '@/web/lib/format.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  RadioGroup,
  SkeletonRows,
  useNow,
} from '@/web/ui/index.ts';
import { useTagScanners } from './enroll-api.ts';

type Scanner = z.infer<typeof TagScannerSchema>;
const D = TAG_COPY.dialog;
const ROLE = { door: 'Door', desk: 'Desk', manager: 'Manager' } as const;

const lastKey = (orgId: string) => `wl.tags.scanner.${orgId}`;
/** The admin's last pick, kept in this browser. */
export function readLastScanner(orgId: string): string | undefined {
  try {
    return localStorage.getItem(lastKey(orgId)) ?? undefined;
  } catch {
    return undefined;
  }
}
export function rememberScanner(orgId: string, id: string): void {
  try {
    localStorage.setItem(lastKey(orgId), id);
  } catch {
    // Private windows block storage; the pick just is not remembered.
  }
}

function why(s: Scanner, mode: Mode, now: number): string | null {
  switch (s.unavailable) {
    case null:
      return null;
    case 'offline':
      return fillAgo(D.rowDisabled.offline, s.lastUsedAt, now);
    case 'no_tags':
      return D.rowDisabled.noTags;
    case 'requests_off':
      return D.rowDisabled.requestsOff;
    case 'busy':
      return D.rowDisabled.busy;
    case 'screen':
      return D.rowDisabled.screen;
    case 'mode':
      return mode === 'live' ? D.rowDisabled.testScanner : D.rowDisabled.liveScanner;
  }
}
const fillAgo = (t: string, at: number | null, now: number) =>
  t.replace('{ago}', at === null ? 'never' : formatAgo(at, now));

/** Last used first, then online desks, then the other online ones, then the ones that cannot. */
export function sortScanners(items: readonly Scanner[], last: string | undefined): Scanner[] {
  const rank = (s: Scanner) => (s.unavailable ? 3 : s.id === last ? 0 : s.role === 'desk' ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function ScannerPicker({
  orgId,
  mode,
  value,
  onChange,
}: {
  orgId: string;
  mode: Mode;
  value: string | undefined;
  onChange: (id: string | undefined, name: string) => void;
}) {
  const query = useTagScanners(orgId, true);
  const now = useNow(30_000);
  const last = readLastScanner(orgId);
  const items = sortScanners(query.data?.items ?? [], last);
  const firstFree = items.find((s) => !s.unavailable);
  useEffect(() => {
    if (value === undefined && firstFree) onChange(firstFree.id, firstFree.name);
  }, [firstFree, onChange, value]);

  if (query.isPending) return <SkeletonRows rows={3} label="Loading scanners" />;
  if (query.isError)
    return <ErrorState inline error={query.error} onRetry={() => query.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState
        inline
        art="scanner"
        title={D.noScanner}
        action={
          <Button asChild variant="outline" size="sm" iconStart={<Plus aria-hidden />}>
            <Link to="/admin/scanning" search={{ tab: 'devices' }}>
              {D.pairScanner}
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <RadioGroup
      legend={D.scanner}
      value={value}
      onValueChange={(id) => onChange(id, items.find((s) => s.id === id)?.name ?? '')}
      options={items.map((s) => {
        const reason = why(s, mode, now);
        const meta = reason
          ? reason
          : [
              'Online',
              s.role ? ROLE[s.role] : null,
              s.sessionName,
              s.secureOnly ? D.secureOnly : null,
            ]
              .filter(Boolean)
              .join(' · ');
        return {
          value: s.id,
          disabled: Boolean(s.unavailable),
          label: (
            <span className="flex min-w-0 items-center gap-2">
              <Tablet aria-hidden className="size-4 shrink-0 text-fg-muted" />
              <span className="truncate">{s.name}</span>
              {s.id === last && !s.unavailable ? <Badge>{D.lastUsed}</Badge> : null}
            </span>
          ),
          hint: meta,
        };
      })}
    />
  );
}
