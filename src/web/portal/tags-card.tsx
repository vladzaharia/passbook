import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Nfc, ShieldX } from 'lucide-react';
import { useState } from 'react';
import type { MyTag } from '@/shared/contracts/me.ts';
import { reportTagLostConfirm } from '../lib/confirms.ts';
import { formatShortDate } from '../lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ListRow,
  ListRows,
  StatusPill,
  toast,
} from '../ui/index.ts';
import { myPassesKey, reportTagLost } from './api.ts';

const nameOf = (tag: MyTag) => tag.label ?? 'Tag';
const masked = (tag: MyTag) => `•• ${tag.hint}`;

function metaOf(tag: MyTag): string {
  if (tag.lostAt !== null) return `${masked(tag)} · Reported ${formatShortDate(tag.lostAt)}`;
  const opens = tag.scope === 'user' ? 'All your passes' : 'This pass';
  return `${opens} · ${masked(tag)} · Added ${formatShortDate(tag.boundAt)}`;
}

/** The tags that open this pass. A holder reports one lost; only the org restores it. */
export function TagsCard({ tags, orgName }: { tags: readonly MyTag[]; orgName: string }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<MyTag | null>(null);
  const report = useMutation({
    mutationFn: reportTagLost,
    onSuccess: async (_res, id) => {
      await client.invalidateQueries({ queryKey: myPassesKey });
      const tag = tags.find((t) => t.id === id);
      toast.success(`${tag ? nameOf(tag) : 'Tag'} reported lost`);
    },
    onError: (e) => toast.error(e, 'Could not report the tag'),
  });
  if (tags.length === 0) return null;
  const confirm = target
    ? reportTagLostConfirm(
        target.label ?? `tag ${masked(target)}`,
        orgName,
        target.scope === 'user',
      )
    : null;
  return (
    <Card>
      <CardHeader title="Tags" />
      <CardBody>
        <ListRows label="Tags">
          {tags.map((tag) => (
            <ListRow
              key={tag.id}
              rowId={tag.id}
              leading={<Nfc aria-hidden />}
              title={nameOf(tag)}
              meta={metaOf(tag)}
              className={tag.lostAt === null ? undefined : 'opacity-70'}
              trailing={
                tag.lostAt === null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconStart={<ShieldX aria-hidden />}
                    onClick={() => setTarget(tag)}
                  >
                    Report lost
                  </Button>
                ) : (
                  <StatusPill status="lost" tone="neutral">
                    Lost
                  </StatusPill>
                )
              }
            />
          ))}
        </ListRows>
      </CardBody>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? 'Report lost'}
        destructive
        onConfirm={async () => {
          if (target) await report.mutateAsync(target.id);
        }}
      />
    </Card>
  );
}
