import { useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { ConfirmDialog, toast } from '@/web/ui/index.ts';
import { useTagMutations } from './api.ts';
import { lostTagConfirm, removeTagConfirm, restoreTagConfirm } from './confirms.ts';
import { useExtraTagMutations } from './tags-extra-api.ts';
import { fill, tagErrorText, tagName } from './words.ts';

type Ask = { kind: 'remove' | 'lost' | 'restore'; tag: Tag };

/**
 * The row actions every tag list shares. Removing a tag from one pass is undone from its toast;
 * a person-wide removal, Report lost and Restore confirm first. Render `dialog` once.
 */
export function useTagActions({ passes }: { passes?: number | undefined } = {}) {
  const [ask, setAsk] = useState<Ask>();
  const mut = useTagMutations();
  const extra = useExtraTagMutations();
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
    if (ask.kind === 'remove') await removeNow(ask.tag);
    else if (ask.kind === 'lost') {
      await mut.lost.mutateAsync(ask.tag.id);
      toast.success(fill(TAG_COPY.lostToast, v));
    } else if (ask.kind === 'restore') {
      await mut.restore.mutateAsync(ask.tag.id);
      toast.success(fill(TAG_COPY.restored, v));
    }
  }
  /** Unbinds, then offers Undo, which binds the tag back the way it was. */
  async function removeNow(t: Tag) {
    const b = t.binding;
    if (!b) return;
    await mut.unbind.mutateAsync(b.id);
    toast.undo(fill(TAG_COPY.removed, { tag: tagName(t) }), () =>
      extra.rebind.mutateAsync({
        passId: b.passId,
        tagId: t.id,
        binding: b.scope === 'user' ? 'user' : 'pass',
      }),
    );
  }
  /** Moves a tag between "this pass" and "all of the person's passes", with Undo. */
  async function changeTo(t: Tag, binding: 'pass' | 'user', name: string, passId?: string) {
    const b = t.binding;
    if (!b) return;
    try {
      await extra.changeBinding.mutateAsync({ bindingId: b.id, binding, passId });
    } catch (cause) {
      toast.error(tagErrorText(cause), 'Could not change the tag');
      return;
    }
    const v = { tag: tagName(t), name };
    toast.undo(fill(binding === 'user' ? TAG_COPY.changed.person : TAG_COPY.changed.pass, v), () =>
      extra.changeBinding.mutateAsync({ bindingId: b.id, binding: b.scope }),
    );
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
    /** One-pass tags go at once (Undo in the toast); person-wide ones ask first. */
    remove: (t: Tag) => {
      if (t.binding?.scope === 'user') setAsk({ kind: 'remove', tag: t });
      else
        void removeNow(t).catch((cause: unknown) =>
          toast.error(tagErrorText(cause), 'Could not remove the tag'),
        );
    },
    changeTo,
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
