import type { UseQueryResult } from '@tanstack/react-query';
import type { BroadcastKind, BroadcastPreviewDto } from '@/shared/contracts/broadcasts.ts';
import { formatDateTime } from '../../lib/format.ts';
import { ConfirmDialog } from '../../ui/index.ts';
import { plural } from './labels.ts';

/**
 * The one confirm before a message or change goes out, for the composer and for a saved draft.
 * It waits for a count of the audience as it stands, and says how holders hear about it.
 */
export function SendConfirm({
  open,
  onOpenChange,
  kind,
  count,
  audience,
  settled = true,
  quiet,
  at,
  later,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: BroadcastKind;
  count: Pick<UseQueryResult<BroadcastPreviewDto>, 'data' | 'isError' | 'isPlaceholderData'>;
  audience?: string;
  /** False while an edit to the audience has not been counted yet. */
  settled?: boolean;
  /** Holders get no lock-screen notice. */
  quiet: boolean;
  at: number | undefined;
  later: boolean;
  onConfirm: (targeted: number) => Promise<void>;
}) {
  const counted = count.data !== undefined && !count.isPlaceholderData && settled;
  const failed = count.isError && count.data === undefined;
  const targeted = count.data?.targeted ?? 0;
  const over = count.data?.overBudget ?? 0;
  const none = (counted && targeted === 0) || failed;
  const passes = plural(targeted, 'pass', 'passes');
  const noun = kind === 'change' ? 'change ' : '';
  const title = failed
    ? 'Could not count the passes'
    : !counted
      ? 'Counting passes'
      : targeted === 0
        ? 'No passes match'
        : later
          ? `Schedule ${noun}for ${passes}?`
          : `Send ${noun}to ${passes}?`;
  const lines = failed
    ? ['Close this and try again.']
    : !counted
      ? ['One moment.']
      : targeted === 0
        ? ['Change the audience first.']
        : [
            audience ? `Audience: ${audience}.` : null,
            'The count is an estimate and may change before sending.',
            later && at !== undefined
              ? `Scheduled to start ${formatDateTime(at)}. You can cancel until then.`
              : null,
            quiet
              ? 'The update is requested without a notification.'
              : 'Eligible passes may receive a notification.',
            over > 0
              ? `${plural(over, 'pass is', 'passes are')} at the daily limit and ${over === 1 ? 'updates' : 'update'} quietly.`
              : null,
          ].flatMap((l) => (l ? [l] : []));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
      confirmLabel={later ? 'Schedule' : 'Send'}
      confirmDisabled={!counted}
      hideConfirm={none}
      cancelLabel={none ? 'Close' : 'Cancel'}
      onConfirm={async () => {
        if (targeted > 0) await onConfirm(targeted);
      }}
    />
  );
}
