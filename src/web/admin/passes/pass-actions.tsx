import { useNavigate } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { Copy, UserMinus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast as sonner } from 'sonner';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { ConfirmDialog, confirmWord, TypedConfirmDialog, toast } from '../../ui/index.ts';
import { usePassActions } from './api.ts';
import { absoluteUrl } from './format.ts';
import { RotatedLinkDialog } from './rotated-link-dialog.tsx';

export type PassActionId =
  | 'update'
  | 'pull'
  | 'void'
  | 'unvoid'
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
>;

const LABEL: Record<PassActionId, string> = {
  update: 'Update devices',
  pull: 'Pull from source',
  void: 'Void',
  unvoid: 'Unvoid',
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
  open: ACTION_ICON.openPublic,
  rotate: ACTION_ICON.rotate,
  download: ACTION_ICON.download,
  copy: Copy,
  clear: UserMinus,
  delete: ACTION_ICON.delete,
};
const DANGER = new Set<PassActionId>(['clear', 'delete']);

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
 * offer the same set. A voided pass shows only Unvoid in the bar and never Update or Pull.
 */
export function actionsFor(pass: ActionPass): PassActionDef[] {
  const voided = pass.status === 'voided';
  const ids: PassActionId[] = voided
    ? ['unvoid', 'open', 'rotate', 'download', 'copy']
    : [pass.connectionId ? 'pull' : 'update', 'void', 'open', 'rotate', 'download', 'copy'];
  if (pass.holderState !== 'unassigned') ids.push('clear');
  ids.push('delete');
  const bar = new Set<PassActionId>(voided ? ['unvoid'] : ['update', 'pull', 'void', 'open']);
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
  const navigate = useNavigate();
  const [ask, setAsk] = useState<'void' | 'clear' | 'delete' | 'rotate' | null>(null);
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
      toast.error(error);
    }
  }

  async function unvoid() {
    try {
      await actions.setVoided.mutateAsync(false);
      sonner.success('Pass unvoided', {
        duration: 6000,
        action: {
          label: 'Undo',
          onClick: () =>
            void actions.setVoided
              .mutateAsync(true)
              .then(() => toast.success('Pass voided'))
              .catch((error: unknown) => toast.error(error)),
        },
      });
    } catch (error) {
      toast.error(error);
    }
  }

  async function copy() {
    if (!links) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl(links.publicUrl));
      bump('copy');
      toast.success('Link copied');
    } catch {
      // Clipboard access can be denied (permissions, insecure context): say how to get the link.
      toast.error(new Error('Could not copy. Open the public page and copy its address.'));
    }
  }

  function run(id: PassActionId) {
    if (id === 'update' || id === 'pull') void refresh(id);
    else if (id === 'unvoid') void unvoid();
    else if (id === 'copy') void copy();
    else if (id === 'open' && links) window.open(links.publicUrl, '_blank', 'noopener,noreferrer');
    else if (id === 'download' && links) window.location.assign(links.downloadUrl);
    else if (id === 'void' || id === 'clear' || id === 'delete' || id === 'rotate') setAsk(id);
  }

  const close = (open: boolean) => !open && setAsk(null);
  const dialogs = (
    <>
      <ConfirmDialog
        open={ask === 'void'}
        onOpenChange={close}
        title="Void pass?"
        description="Wallet shows it as void on the holder's device. You can unvoid it later."
        confirmLabel="Void"
        destructive
        onConfirm={async () => {
          await actions.setVoided.mutateAsync(true);
          bump('void');
          toast.success('Pass voided');
        }}
      />
      <ConfirmDialog
        open={ask === 'clear'}
        onOpenChange={close}
        title="Clear holder?"
        description={
          pass.holderState === 'owned'
            ? `${pass.holderEmail ?? 'The owner'} loses the pass in their account.`
            : 'The pass goes back to having no holder.'
        }
        confirmLabel="Clear holder"
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
        title="Delete pass?"
        description="Voids it on every device, then removes it with its versions and images."
        word={confirmWord({ title: pass.title, slug: pass.serial })}
        confirmLabel="Delete pass"
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success(`${name} deleted`);
          if (options.onDeleted) options.onDeleted();
          else void navigate({ to: '/admin/passes' });
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
    },
    done,
    dialogs,
  };
}
