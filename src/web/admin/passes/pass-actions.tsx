import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { copyText } from '../../lib/clipboard.ts';
import {
  clearHolderConfirm,
  deleteConfirm,
  newCodeConfirm,
  voidConfirm,
} from '../../lib/confirms.ts';
import { useMode } from '../../lib/mode.ts';
import { sessionQuery } from '../../lib/session.ts';
import { ConfirmDialog, confirmWord, TypedConfirmDialog, toast } from '../../ui/index.ts';
import { usePassActions } from './api.ts';
import { usePassRemoval } from './api-removal.ts';
import { RemoveDialog } from './detail/remove-dialog.tsx';
import { absoluteUrl } from './format.ts';
import {
  type ActionPass,
  actionsFor,
  type PassActionDef,
  type PassActionId,
  READ_ONLY,
} from './pass-action-defs.ts';
import { RotateLink } from './rotated-link-dialog.tsx';

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
  options: { canOperate: boolean; onDeleted?: () => void },
): PassActionRunner {
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const removal = usePassRemoval(pass.id);
  const navigate = useNavigate();
  const mode = useMode();
  const foreign = pass.mode !== undefined && pass.mode !== mode;
  const canChange = options.canOperate && !foreign;
  const defs = actionsFor(pass, !canChange);
  const [ask, setAsk] = useState<
    'void' | 'clear' | 'delete' | 'rotate' | 'newcode' | 'remove' | null
  >(null);
  const [done, setDone] = useState<Partial<Record<PassActionId, number>>>({});
  const bump = (id: PassActionId) => setDone((d) => ({ ...d, [id]: (d[id] ?? 0) + 1 }));
  const name = pass.title ?? pass.serial;

  async function refresh(id: 'update' | 'pull') {
    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    try {
      await actions.refreshFromSource.mutateAsync();
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (!current?.authenticated || current.user.id !== userId) return;
      bump(id);
      const afterState = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (!afterState?.authenticated || afterState.user.id !== userId) return;
      toast.info(id === 'pull' ? 'Pull requested' : 'Update requested');
    } catch (error) {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      if (!current?.authenticated || current.user.id !== userId) return;
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
      undoToast.current = toast.undo('Pass restored', () => setAsk('remove'));
    } catch (error) {
      toast.error(error, 'Could not restore');
    }
  }

  async function copy() {
    if (links && (await copyText(absoluteUrl(links.publicUrl), 'link'))) bump('copy');
  }

  function run(id: PassActionId) {
    if (!canChange && !READ_ONLY.has(id)) return;
    if (id === 'update' || id === 'pull') void refresh(id);
    else if (id === 'unvoid') void unvoid();
    else if (id === 'restore') void restore();
    else if (id === 'copy') void copy();
    else if (id === 'open' && links) window.open(links.publicUrl, '_blank', 'noopener,noreferrer');
    else if (id === 'download' && links && !defs.find((d) => d.id === id)?.disabled)
      window.location.assign(links.downloadUrl);
    else if (
      id === 'void' ||
      id === 'remove' ||
      id === 'clear' ||
      id === 'delete' ||
      id === 'rotate' ||
      id === 'newcode'
    )
      setAsk(id);
  }

  const close = (open: boolean) => !open && setAsk(null);
  const dialogs = canChange ? (
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
        pass={pass}
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
          const holder = await actions.unassign.mutateAsync();
          if (holder.transfer?.state === 'pending')
            toast.info('Holder removal pending while existing wallet credentials are retired.');
          else toast.success('Holder cleared');
        }}
      />
      <ConfirmDialog
        open={ask === 'newcode'}
        onOpenChange={close}
        {...newCodeConfirm()}
        onConfirm={async () => {
          await actions.newCode.mutateAsync();
          bump('newcode');
          toast.success('New code made');
        }}
      />
      <RotateLink
        open={ask === 'rotate'}
        onOpenChange={close}
        description="The current link and download stop working. Devices keep the pass."
        rotate={async () => {
          const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (!before?.authenticated) throw new Error('Sign in to rotate the link.');
          const userId = before.user.id;
          const next = await actions.rotateLink.mutateAsync();
          const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (current?.authenticated && current.user.id === userId) bump('rotate');
          return next.publicUrl;
        }}
        holderEmail={pass.holderEmail}
        mode={pass.mode}
        sendEmail={(key) => actions.resendEmail.mutateAsync({ key })}
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
    </>
  ) : null;

  return {
    defs,
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
