import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { CapturedEmailSchema } from '@/shared/contracts/sandbox.ts';
import { WB_INBOX } from '@/shared/copy/workbench-inbox.ts';
import { WB_EMPTY } from '@/shared/copy/workbench-states.ts';
import { wbPath } from '@/shared/workbench.ts';
import { EmailDetail } from '../../admin/test-inbox/preview.tsx';
import { useCapturedEmails } from '../../admin/test-inbox/queries.ts';
import { Button } from '../../ui/button.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import type { BenchRowParts } from '../bench/list.tsx';
import { BenchList } from '../bench/list.tsx';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';
import { useWorkbenchInboxHost } from './inbox-host.ts';
import { useBenchRouter } from './use-bench-router.ts';
import '../bench/bench.css';
import '../bench/pane.css';
import './inbox.css';

type Email = z.infer<typeof CapturedEmailSchema>;
const idOf = (m: Email) => m.id;

function row(m: Email): BenchRowParts {
  return {
    lead: <BenchTime at={m.createdAt} />,
    title: <span className="inbox-subject">{m.subject}</span>,
    meta: <span className="inbox-to">{m.to}</span>,
    trail: m.failed ? (
      <StatusChip tone="danger">{WB_INBOX.failed}</StatusChip>
    ) : (
      <span className="inbox-kind">{m.kind === 'bundle' ? 'Bundle' : 'Pass'}</span>
    ),
  };
}

/** Test mail, held back from its recipient: the one inbox admin shows, on the Workbench's bench. */
export function InboxPage() {
  const { context } = useToolHost();
  const host = useWorkbenchInboxHost();
  const list = useCapturedEmails(host);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  useBenchRouter();
  const selection = useBenchSelection({ items: rows, idOf, ready: list.isSuccess });
  const id = selection.selectedId;
  const at = id ? rows.findIndex((m) => m.id === id) : -1;
  useBenchKeys({
    next: () => selection.step(1),
    prev: () => selection.step(-1),
    close: () => {
      if (selection.open) selection.setOpen(false);
    },
  });

  let body: React.ReactNode;
  if (!host.canRead || list.isPending) body = <BenchSkeleton rows={5} />;
  else if (list.isError) body = <ToolFailed error={list.error} onRetry={() => list.refetch()} />;
  else if (rows.length === 0 && !id)
    body = (
      <ToolEmpty
        tool="inbox"
        action={
          <Button asChild variant="outline">
            <Link to={wbPath(context.orgId, 'passes', { query: { view: 'phone' } })}>
              {WB_EMPTY.inbox?.action}
            </Link>
          </Button>
        }
      />
    );
  else {
    const pane =
      id && host.orgId && host.userId ? (
        <EmailDetail
          key={id}
          id={id}
          orgId={host.orgId}
          userId={host.userId}
          host={host}
          forLink={(email) => (
            <Link to={wbPath(context.orgId, 'passes')} hash={email.passId ?? undefined}>
              {email.kind === 'bundle' ? WB_INBOX.forBundle : WB_INBOX.forPass}
            </Link>
          )}
          frame={(title, content) => (
            <Inspector
              title={title}
              label={`Email ${title}`}
              itemKey={id}
              onPrev={at > 0 ? () => selection.step(-1) : undefined}
              onNext={at >= 0 && at < rows.length - 1 ? () => selection.step(1) : undefined}
            >
              <div className="inbox-detail">{content}</div>
            </Inspector>
          )}
        />
      ) : (
        <p className="inbox-none">{WB_INBOX.select}</p>
      );
    const count = WB_INBOX.count(rows.length, list.hasNextPage);
    body = (
      <>
        <BenchSlot name="count">{count}</BenchSlot>
        <BenchSplit
          main={
            <BenchList
              label={WB_INBOX.list}
              items={rows}
              idOf={idOf}
              row={row}
              tone={(m) => (m.failed ? 'danger' : 'neutral')}
              selection={selection}
              footer={{
                count,
                onMore: list.hasNextPage ? () => void list.fetchNextPage() : undefined,
                loading: list.isFetchingNextPage,
              }}
            />
          }
          pane={pane}
          open={selection.open && id !== null}
          onClose={() => selection.setOpen(false)}
          label={WB_INBOX.list}
          bare
        />
      </>
    );
  }
  return <ToolPage tool="inbox">{body}</ToolPage>;
}
