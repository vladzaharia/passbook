import { Link } from '@tanstack/react-router';
import { ShieldX, Trash2, Undo2 } from 'lucide-react';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  ErrorState,
  KeyValue,
  Sheet,
  SheetContent,
  SkeletonKeyValue,
} from '@/web/ui/index.ts';
import { useTag } from './api.ts';
import { KindPill } from './enroll-result.tsx';
import { useTagActions } from './tag-actions.tsx';
import { TagCode } from './tag-code.tsx';
import { TagHistory } from './tag-history.tsx';
import { WorksWithChip } from './tag-row.tsx';
import { StateBadge } from './tags-state.tsx';
import { lastUsedLine, metaLine, tagName } from './words.ts';

/**
 * One tag: what it works with, who assigned it and when, last use. Report lost, Restore and Remove
 * confirm like they do in the pass card. History comes from its own route.
 */
export function TagSheet({
  id,
  readOnly,
  onClose,
}: {
  id: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const query = useTag(id);
  const actions = useTagActions();
  const tag = query.data;
  const b = tag?.binding;
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent title={tag ? tagName(tag) : 'Tag'} className="sm:w-[440px]">
          <div className="flex flex-col gap-5 p-5">
            {query.isPending ? (
              <SkeletonKeyValue label="Loading tag" />
            ) : query.isError ? (
              <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
            ) : tag ? (
              <>
                <div className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold text-fg-strong">{tagName(tag)}</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <KindPill assurance={tag.assurance} />
                    <StateBadge state={tag.state} />
                  </div>
                </div>
                <KeyValue
                  items={[
                    {
                      label: 'Code',
                      value: <TagCode hint={tag.hint} />,
                      mono: true,
                    },
                    {
                      label: 'Works with',
                      value: b ? <WorksWithChip tag={tag} /> : null,
                    },
                    {
                      label: 'Pass',
                      value: b ? (
                        <Link
                          to="/admin/passes/$passId"
                          params={{ passId: b.passId }}
                          className="underline-offset-2 hover:underline"
                        >
                          {b.passTitle ?? 'Pass'}
                        </Link>
                      ) : null,
                    },
                    {
                      label: 'Assigned',
                      value: b ? metaLine(tag).replace(/^•• \w{4} · /, '') : null,
                    },
                    { label: 'Last used', value: lastUsedLine(tag).replace(/^Last used /, '') },
                    { label: 'Added', value: formatDateTime(tag.createdAt) },
                  ]}
                />
                <TagHistory tagId={tag.id} />
                {readOnly ? null : (
                  <div className="flex flex-wrap gap-2">
                    {tag.state === 'lost' ? (
                      <Button
                        variant="outline"
                        iconStart={<Undo2 aria-hidden />}
                        onClick={() => actions.restore(tag)}
                      >
                        {TAG_COPY.menu.restore}
                      </Button>
                    ) : tag.state === 'assigned' ? (
                      <>
                        <Button
                          variant="outline"
                          iconStart={<ShieldX aria-hidden />}
                          onClick={() => actions.lost(tag)}
                        >
                          {TAG_COPY.menu.reportLost}
                        </Button>
                        <Button
                          variant="outline"
                          iconStart={<Trash2 aria-hidden />}
                          onClick={() => actions.remove(tag)}
                        >
                          {TAG_COPY.removePerson.confirm}
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      {actions.dialog}
    </>
  );
}
