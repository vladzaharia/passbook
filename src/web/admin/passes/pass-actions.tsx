import { useNavigate } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { Copy, UserMinus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { copyText } from '../../lib/clipboard.ts';
import { clearHolderConfirm, deleteConfirm, voidConfirm } from '../../lib/confirms.ts';
import { ConfirmDialog, confirmWord, TypedConfirmDialog, toast } from '../../ui/index.ts';
import { usePassActions } from './api.ts';
import { RemoveDialog } from './detail/remove-dialog.tsx';
import { usePassRemoval } from './detail/sync-api.ts';
import { absoluteUrl } from './format.ts';
import { RotatedLinkDialog } from './rotated-link-dialog.tsx';

export type PassActionId =
  | 'update'
  | 'pull'
  | 'void'
  | 'unvoid'
  | 'remove'
  | 'restore'
  | 'open'
  | 'rotate'
  | 'download'
  | 'copy'
  | 'clear'
  | 'delete';

type ActionPass = Pick<
  PassSummaryDto,
  | 'id'
  | 'title'
  | 'serial'
  | 'status'
  | 'connectionId'
  | 'holderState'
  | 'holderEmail'
  | 'deviceCount'
> & { removedAt?: number | null | undefined };

const LABEL: Record<PassActionId, string> = {
  update: 'Update devices',
  pull: 'Pull from source',
  void: 'Void',
  unvoid: 'Unvoid',
  remove: 'Remove from Wallet',
  restore: 'Restore',
  open: 'Open public page',
  rotate: 'Rotate link',
  download: 'Download .pkpass',
  copy: 'Copy link',
  clear: 'Clear holder',
  delete: 'Delete',
};
const ICON: Record<PassActionId, LucideIcon> = {
  update: ACTION_ICON.updateDevices,
  pull: ACTION_ICON.refresh,
  void: ACTION_ICON.void,
  unvoid: ACTION_ICON.unvoid,
  remove: ACTION_ICON.removeFromWallet,
  restore: ACTION_ICON.restoreToWallet,
  open: ACTION_ICON.openPublic,
  rotate: ACTION_ICON.rotate,
  download: ACTION_ICON.download,
  copy: Copy,
  clear: UserMinus,
  delete: ACTION_ICON.delete,
};
const DANGER = new Set<PassActionId>(['remove', 'clear', 'delete']);

export interface PassActionDef {
  id: PassActionId;
  label: string;
  icon: LucideIcon;
  destructive: boolean;
  /** Shown as a header button; the rest go in More. */
  bar: boolean;
}

/**
 * Every action a pass offers, in order. The header and the row menu both read this, so they always
 * offer the same set. A voided pass shows only Unvoid in the bar and never Update or Pull. A
 * removed pass shows only Restore: it stays removed until restored, so Void and Update would lie.
 */
export function actionsFor(pass: ActionPass): PassActionDef[] {
  const removed = pass.removedAt != null;
  const voided = pass.status === 'voided';
  const ids: PassActionId[] = removed
    ? ['restore', 'open', 'rotate', 'download', 'copy']
    : voided
      ? ['unvoid', 'open', 'rotate', 'download', 'copy', 'remove']
      : [
          pass.connectionId ? 'pull' : 'update',
          'void',
          'open',
          'rotate',
          'download',
          'copy',
          'remove',
        ];
  if (pass.holderState !== 'unassigned') ids.push('clear');
  ids.push('delete');
  const bar = new Set<PassActionId>(
    removed ? ['restore'] : voided ? ['unvoid'] : ['update', 'pull', 'void', 'open'],
  );
  return ids.map((id) => ({
    id,
    label: LABEL[id],
    icon: ICON[id],
    destructive: DANGER.has(id),
    bar: bar.has(id),
  }));
}

export interface PassLinks {
  publicUrl: string;
  downloadUrl: string;
}

export interface PassActionRunner {
  defs: PassActionDef[];
  run: (id: PassActionId) => void;
  /** Links for open, download and copy; undefined until the detail is loaded. */
  links: PassLinks | undefined;
  pending: Partial<Record<PassActionId, boolean>>;
  /** Changes when the server confirms an action, so its icon plays the verb. */
  done: Partial<Record<PassActionId, number>>;
  dialogs: ReactNode;
}

/** Runs pass actions with the same guards everywhere: confirms, typed delete, undo for unvoid. */
export function usePassActionRunner(
  pass: ActionPass,
  links: PassLinks | undefined,
  options: { onDeleted?: () => void } = {},
): PassActionRunner {
  const actions = usePassActions(pass.id);
  const removal = usePassRemoval(pass.id);
  const navigate = useNavigate();
  const [ask, setAsk] = useState<'void' | 'clear' | 'delete' | 'rotate' | 'remove' | null>(null);
  const [rotated, setRotated] = useState<PassLinks | null>(null);
  const [done, setDone] = useState<Partial<Record<PassActionId, number>>>({});
  const bump = (id: PassActionId) => setDone((d) => ({ ...d, [id]: (d[id] ?? 0) + 1 }));
  const name = pass.title ?? pass.serial;

  async function refresh(id: 'update' | 'pull') {
    try {
      await actions.refreshFromSource.mutateAsync();
      bump(id);
      const n = pass.deviceCount;
      toast.success(
        id === 'pull'
          ? 'Pull requested'
          : n > 0
            ? `Update sent to ${n} ${n === 1 ? 'device' : 'devices'}`
            : 'Update queued',
      );
    } catch (error) {
      toast.error(error, id === 'pull' ? 'Could not pull' : 'Could not update');
    }
  }

  // Undo re-voids, so it asks the same "Void pass?" as Void does: the confirm guards what holders
  // see, whatever the entry point. The offer goes with this page, which owns that confirm.
  const undoToast = useRef<string | number | undefined>(undefined);
  useEffect(() => () => toast.dismiss(undoToast.current), []);
  async function unvoid() {
    try {
      await actions.setVoided.mutateAsync(false);
      undoToast.current = toast.undo('Pass unvoided', () => setAsk('void'));
    } catch (error) {
      toast.error(error, 'Could not unvoid');
    }
  }

  async function restore() {
    try {
      await removal.restore.mutateAsync();
      bump('restore');
      toast.success('Pass restored');
    } catch (error) {
      toast.error(error, 'Could not restore');
    }
  }

  async function copy() {
    if (links && (await copyText(absoluteUrl(links.publicUrl), 'link'))) bump('copy');
  }

  function run(id: PassActionId) {
    if (id === 'update' || id === 'pull') void refresh(id);
    else if (id === 'unvoid') void unvoid();
    else if (id === 'restore') void restore();
    else if (id === 'copy') void copy();
    else if (id === 'open' && links) window.open(links.publicUrl, '_blank', 'noopener,noreferrer');
    else if (id === 'download' && links) window.location.assign(links.downloadUrl);
    else if (
      id === 'void' ||
      id === 'remove' ||
      id === 'clear' ||
      id === 'delete' ||
      id === 'rotate'
    )
      setAsk(id);
  }

  const close = (open: boolean) => !open && setAsk(null);
  const dialogs = (
    <>
      <ConfirmDialog
        open={ask === 'void'}
        onOpenChange={close}
        {...voidConfirm()}
        destructive
        onConfirm={async () => {
          await actions.setVoided.mutateAsync(true);
          bump('void');
          toast.success('Pass voided');
        }}
      />
      <RemoveDialog
        open={ask === 'remove'}
        onOpenChange={close}
        onConfirm={async (message) => {
          await removal.remove.mutateAsync(message);
          bump('remove');
          toast.success('Pass removed from Wallet');
        }}
      />
      <ConfirmDialog
        open={ask === 'clear'}
        onOpenChange={close}
        {...clearHolderConfirm(
          pass.holderState === 'owned' ? (pass.holderEmail ?? 'The owner') : null,
        )}
        destructive
        onConfirm={async () => {
          await actions.unassign.mutateAsync();
          toast.success('Holder cleared');
        }}
      />
      <ConfirmDialog
        open={ask === 'rotate'}
        onOpenChange={close}
        title="Rotate link?"
        description="The current link and download stop working. Devices keep the pass."
        confirmLabel="Rotate"
        destructive
        onConfirm={async () => {
          const next = await actions.rotateLink.mutateAsync();
          bump('rotate');
          setRotated(next);
        }}
      />
      <TypedConfirmDialog
        open={ask === 'delete'}
        onOpenChange={close}
        {...deleteConfirm('pass', name)}
        word={confirmWord({ title: pass.title, slug: pass.serial })}
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success(`${name} deleted`);
          if (options.onDeleted) options.onDeleted();
          else void navigate({ to: '/admin/passes', replace: true });
        }}
      />
      <RotatedLinkDialog
        links={rotated}
        holderEmail={pass.holderEmail}
        passId={pass.id}
        onClose={() => setRotated(null)}
      />
    </>
  );

  return {
    defs: actionsFor(pass),
    run,
    links,
    pending: {
      update: actions.refreshFromSource.isPending,
      pull: actions.refreshFromSource.isPending,
      unvoid: actions.setVoided.isPending,
      restore: removal.restore.isPending,
    },
    done,
    dialogs,
  };
}
