import type { TagBinding } from '@/shared/contracts/nfc-tags.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { ErrorState, ListRow, ListRows, SkeletonRows } from '@/web/ui/index.ts';
import { useTagHistory } from './tags-extra-api.ts';
import { worksWithLabel } from './words.ts';

const CAUSE: Record<NonNullable<TagBinding['endCause']>, string> = {
  admin: 'Removed by an admin',
  staff: 'Removed by staff',
  undo: 'Undone',
  lost: 'Reported lost',
  replaced: 'Replaced',
  moved: 'Moved to someone else',
  holder_changed: 'The pass changed hands',
  pass_deleted: 'The pass was deleted',
  no_passes: 'The holder has no passes',
  offboard: 'The holder was offboarded',
  visitor_out: 'Returned at the desk',
  pass_ended: 'The pass ended',
  tag_retired: 'The tag was retired',
  channel_off: 'NFC was turned off for the pass',
  expired: 'The assignment ended',
  type_changed: 'The tag type changed',
};

const EVENT = {
  lost: 'Reported lost',
  retire: 'Retired',
  restore: 'Restored',
  update: 'Renamed',
} as const;

/** Every binding the tag has had, newest first: what it worked with, when, and how it ended. */
export function TagHistory({ tagId }: { tagId: string }) {
  const query = useTagHistory(tagId);
  if (query.isPending) return <SkeletonRows rows={2} label="Loading history" />;
  if (query.isError)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;
  const events = query.data.events;
  if (query.data.items.length === 0 && events.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">History</h3>
      <ListRows label="History">
        {query.data.items.map((b) => (
          <ListRow
            key={b.id}
            title={`${worksWithLabel(b)}${b.passTitle ? ` · ${b.passTitle}` : ''}`}
            meta={
              <>
                <span className="block">
                  {formatDateTime(b.boundAt)}
                  {b.boundByName ? ` by ${b.boundByName}` : ''}
                </span>
                <span className="block">
                  {b.endedAt === null
                    ? 'Now'
                    : `${formatDateTime(b.endedAt)} · ${b.endCause ? CAUSE[b.endCause] : 'Ended'}`}
                </span>
              </>
            }
          />
        ))}
      </ListRows>
      {events.length > 0 ? (
        <ListRows label="Changes">
          {events.map((e) => (
            <ListRow
              key={`${e.at}-${e.action}`}
              title={EVENT[e.action]}
              meta={`${formatDateTime(e.at)}${e.actorName ? ` by ${e.actorName}` : ''}`}
            />
          ))}
        </ListRows>
      ) : null}
    </section>
  );
}
