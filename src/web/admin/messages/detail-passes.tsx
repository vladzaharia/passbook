import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { ENTITY } from '../../lib/entities.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  ListRow,
  ListRows,
  LoadMore,
  RowLink,
  SegmentedControl,
  SkeletonRows,
} from '../../ui/index.ts';
import { type BroadcastItem, type ItemOutcome, useBroadcastItems } from './api.ts';

const OUTCOME_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'updated', label: 'Updated' },
  { value: 'unchanged', label: 'Unchanged' },
  { value: 'failed', label: 'Failed' },
] as const;

const OUTCOME_TONE = { updated: 'success', unchanged: 'neutral', failed: 'danger' } as const;

function ItemRow({ item }: { item: BroadcastItem }) {
  const short = `Pass ${item.passId.slice(-6)}`;
  const name = item.holderEmail ?? item.title ?? short;
  return (
    <ListRow
      rowId={item.passId}
      leading={<ENTITY.pass.icon aria-hidden />}
      title={
        <RowLink
          to="/admin/passes/$passId"
          params={{ passId: item.passId }}
          search={{ tab: 'sync' }}
          aria-label={`Sync log of ${name === short ? short : `${name}, ${short}`}`}
        >
          {name}
        </RowLink>
      }
      meta={name === short ? undefined : item.holderEmail ? (item.title ?? short) : short}
      trailing={
        <span className="flex items-center gap-1.5">
          {item.silent ? <Badge>Silent</Badge> : null}
          <Badge tone={OUTCOME_TONE[item.outcome]}>
            {item.outcome === 'updated'
              ? 'Updated'
              : item.outcome === 'failed'
                ? 'Failed'
                : 'Unchanged'}
          </Badge>
        </span>
      }
    />
  );
}

/** Which passes the run updated, left alone or failed, each linking to its Sync log. */
export function PassesCard({
  b,
  outcome,
  onOutcome,
}: {
  b: BroadcastDto;
  outcome: ItemOutcome | undefined;
  onOutcome: (next: ItemOutcome | undefined) => void;
}) {
  const list = useBroadcastItems(b.id, outcome, b.state === 'sending');
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader
        title="Passes"
        actions={
          <SegmentedControl
            label="Outcome"
            options={OUTCOME_FILTERS}
            value={outcome ?? 'all'}
            onValueChange={(v) => onOutcome(v === 'all' ? undefined : v)}
          />
        }
      />
      <CardBody>
        {list.isError && rows.length === 0 ? (
          <ErrorState inline error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <SkeletonRows label="Loading passes" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {outcome ? `No ${outcome} passes.` : 'No passes handled yet.'}
          </p>
        ) : (
          <>
            <ListRows label="Passes">
              {rows.map((item) => (
                <ItemRow key={item.passId} item={item} />
              ))}
            </ListRows>
            <LoadMore query={list} shown={rows.length} noun={['pass', 'passes']} />
          </>
        )}
      </CardBody>
    </Card>
  );
}
