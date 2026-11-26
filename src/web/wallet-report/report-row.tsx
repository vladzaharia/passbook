import { DoorOpen, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { omissionKey } from '@/passkit/wallets/fidelity.ts';
import type { ReportItem } from '@/passkit/wallets/types.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Badge } from '../ui/badge.tsx';

const C = WALLETS_COPY.report;

/** One thing the wallet leaves out or draws differently: the compiler's message, then where it is. */
export function ReportRow({
  item,
  where,
  isNew,
  review,
  action,
  menu,
}: {
  item: ReportItem;
  where: string;
  isNew?: boolean | undefined;
  /** Review host: the approval key under the row, in mono. */
  review?: boolean | undefined;
  action?: ReactNode;
  menu?: ReactNode;
}) {
  const who =
    item.group === 'door'
      ? { Icon: DoorOpen, text: C.door }
      : item.group === 'holder'
        ? { Icon: EyeOff, text: C.holders }
        : null;
  const id = omissionKey(item);
  return (
    <li
      data-row-id={`wr-${id}`}
      data-new={isNew || undefined}
      className="flex items-start gap-2 px-3 py-2 text-sm"
    >
      {action}
      {who ? (
        <span className="mt-0.5 shrink-0 text-fg-muted" title={who.text}>
          <who.Icon aria-hidden className="size-4" />
          <span className="sr-only">{who.text}</span>
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-fg [overflow-wrap:anywhere]">{item.message}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>{where}</span>
          {item.chosen ? <Badge tone="neutral">{WALLETS_COPY.fields.leftOut}</Badge> : null}
          {review ? <code className="font-mono [overflow-wrap:anywhere]">{id}</code> : null}
        </span>
      </span>
      {menu}
    </li>
  );
}
