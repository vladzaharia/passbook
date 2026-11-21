import type { LucideIcon } from 'lucide-react';
import { Copy, UserMinus } from 'lucide-react';
import type { ChannelReason, EffectiveChannels } from '@/shared/contracts/channels.ts';
import type { Mode } from '@/shared/contracts/common.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { channelReason } from '@/shared/copy/channels.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';

export type PassActionId =
  | 'update'
  | 'pull'
  | 'void'
  | 'unvoid'
  | 'remove'
  | 'restore'
  | 'open'
  | 'rotate'
  | 'newcode'
  | 'download'
  | 'copy'
  | 'clear'
  | 'delete';

export type ActionPass = Pick<
  PassSummaryDto,
  | 'id'
  | 'orgId'
  | 'title'
  | 'serial'
  | 'status'
  | 'connectionId'
  | 'holderState'
  | 'holderEmail'
  | 'deviceCount'
> & {
  removedAt?: number | null | undefined;
  mode?: Mode | undefined;
  /** The detail knows what the Apple channel allows; a row does not, and keeps the action. */
  channels?: EffectiveChannels | undefined;
  /** A developer sandbox pass is a preview only: it has no file to download. */
  testPreview?: boolean | undefined;
};

const LABEL: Record<PassActionId, string> = {
  update: 'Update devices',
  pull: 'Pull from source',
  void: 'Void',
  unvoid: 'Unvoid',
  remove: 'Remove from Wallet',
  restore: 'Restore',
  open: 'Open public page',
  rotate: 'Rotate link',
  newcode: 'New code',
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
  newcode: ACTION_ICON.refresh,
  download: ACTION_ICON.download,
  copy: Copy,
  clear: UserMinus,
  delete: ACTION_ICON.delete,
};
const DANGER = new Set<PassActionId>(['remove', 'clear', 'delete']);
const appleOffReason = (reason: ChannelReason | undefined): string =>
  reason ? channelReason('apple', reason) : 'Apple Wallet: off';

export interface PassActionDef {
  id: PassActionId;
  label: string;
  icon: LucideIcon;
  destructive: boolean;
  /** Shown as a header button; the rest go in More. */
  bar: boolean;
  /** Only reading actions stay on when changes are unavailable. */
  disabled: boolean;
  /** Why a disabled action is unavailable. */
  reason?: string | undefined;
}

export const READ_ONLY = new Set<PassActionId>(['open', 'download', 'copy']);

/**
 * Every action a pass offers, in order. The header and the row menu both read this, so they always
 * offer the same set. A voided pass shows only Unvoid in the bar and never Update or Pull. A
 * removed pass shows only Restore: it stays removed until restored, so Void and Update would lie,
 * and its link and download are gone with it. `readOnly` greys out changes.
 */
export function actionsFor(pass: ActionPass, readOnly = false): PassActionDef[] {
  const removed = pass.removedAt != null;
  const voided = pass.status === 'voided';
  const ids: PassActionId[] = removed
    ? ['restore', 'open', 'copy']
    : voided
      ? ['unvoid', 'open', 'rotate', 'download', 'copy', 'remove']
      : [
          pass.connectionId ? 'pull' : 'update',
          'void',
          'open',
          'rotate',
          'newcode',
          'download',
          'copy',
          'remove',
        ];
  if (pass.holderState !== 'unassigned') ids.push('clear');
  ids.push('delete');
  const bar = new Set<PassActionId>(
    removed ? ['restore'] : voided ? ['unvoid'] : ['update', 'pull', 'void', 'open'],
  );
  const apple = pass.channels?.apple;
  return ids
    .filter((id) => !(id === 'download' && pass.testPreview))
    .map((id) => {
      const reason =
        id === 'download' && apple && !apple.on ? appleOffReason(apple.reason) : undefined;
      return {
        id,
        label: LABEL[id],
        icon: ICON[id],
        destructive: DANGER.has(id),
        bar: bar.has(id),
        disabled: (readOnly && !READ_ONLY.has(id)) || reason !== undefined,
        reason,
      };
    });
}
