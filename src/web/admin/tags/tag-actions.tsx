import { useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { ConfirmDialog, toast } from '@/web/ui/index.ts';
import { useTagMutations } from './api.ts';
import { lostTagConfirm, removeTagConfirm, restoreTagConfirm } from './confirms.ts';
import { fill, tagName } from './words.ts';

type Ask = { kind: 'remove' | 'lost' | 'restore'; tag: Tag };

/**
 * The row actions every tag list shares: Remove, Report lost and Restore each confirm first, then
 * toast. Remove has no Undo: nothing admin-side can put a tag back on a pass yet.
 * Render `dialog` once beside the list.
 */
export function useTagActions({ passes }: { passes?: number | undefined } = {}) {
  const [ask, setAsk] = useState<Ask>();
  const mut = useTagMutations();
  const tag = ask ? tagName(ask.tag) : '';
  const copy = !ask
    ? undefined
    : ask.kind === 'remove'
      ? removeTagConfirm(
          tag,
          ask.tag.binding?.scope === 'user'
            ? { person: true, name: ask.tag.binding.holderName ?? 'the holder', passes }
            : { person: false },
        )
      : ask.kind === 'lost'
        ? lostTagConfirm(tag)
        : restoreTagConfirm(tag, 'its last holder');

  async function run() {
    if (!ask) return;
    const v = { tag };
    if (ask.kind === 'remove' && ask.tag.binding) {
      const bindingId = ask.tag.binding.id;
      await mut.unbind.mutateAsync(bindingId);
      toast.success(fill(TAG_COPY.removed, v));
    } else if (ask.kind === 'lost') {
      await mut.lost.mutateAsync(ask.tag.id);
      toast.success(fill(TAG_COPY.lostToast, v));
    } else if (ask.kind === 'restore') {
      await mut.restore.mutateAsync(ask.tag.id);
      toast.success(fill(TAG_COPY.restored, v));
    }
  }
  const dialog = copy ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) setAsk(undefined);
      }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      destructive={ask?.kind !== 'restore'}
      onConfirm={run}
    />
  ) : null;
  return {
    dialog,
    remove: (t: Tag) => setAsk({ kind: 'remove', tag: t }),
    lost: (t: Tag) => setAsk({ kind: 'lost', tag: t }),
    restore: (t: Tag) => setAsk({ kind: 'restore', tag: t }),
    rename: async (t: Tag, label: string) => {
      try {
        await mut.rename.mutateAsync({ id: t.id, label: label.trim() || null });
        return true;
      } catch (cause) {
        toast.error(cause, 'Could not change the tag');
        return false;
      }
    },
  };
}
export type TagActions = ReturnType<typeof useTagActions>;
