import { X } from 'lucide-react';
import { useState } from 'react';
import { BUNDLE_MAX_PASSES } from '@/shared/contracts/bundles.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { voidConfirm } from '../../lib/confirms.ts';
import { BELOW_LG, useMediaQuery } from '../../lib/media.ts';
import {
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  IconButton,
  MoreMenu,
  toast,
  useBottomBar,
} from '../../ui/index.ts';
import { useBulkPassAction } from './api.ts';
import { BundleDialog } from './bundle-dialog.tsx';
import { RemoveDialog } from './detail/remove-dialog.tsx';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SHARE_HINT = `Up to ${BUNDLE_MAX_PASSES} passes of one organization.`;

/**
 * Fixed at the bottom while rows are selected: n selected, then the bulk actions. Below lg the
 * primary two stay on the row and the rest go in More. Email and Void confirm with the count of
 * passes they will touch; Void uses the danger button.
 */
export function SelectionBar({
  picked,
  orgId,
  bundleOrgId,
  onClear,
  onExport,
}: {
  /** The selected rows: what each action touches is counted from them. */
  picked: PassSummaryDto[];
  orgId: string | undefined;
  /** The one org of the selected passes; null when they span several. */
  bundleOrgId: string | null;
  onClear: () => void;
  onExport: () => void;
}) {
  const bulk = useBulkPassAction();
  const [ask, setAsk] = useState<'void' | 'send_email' | 'remove' | null>(null);
  const [sharing, setSharing] = useState(false);
  const barRef = useBottomBar<HTMLElement>();
  const compact = useMediaQuery(BELOW_LG);
  const ids = picked.map((p) => p.id);
  const n = ids.length;
  const changeable = picked.filter((p) => p.removedAt === null).length;
  const emailable = picked.filter((p) => p.holderEmail !== null).length;
  const canShare = n <= BUNDLE_MAX_PASSES && bundleOrgId !== null;
  if (n === 0) return null;

  async function run(action: 'void' | 'send_email' | 'remove', message?: string) {
    const result = await bulk.mutateAsync({
      action,
      ids,
      ...(message ? { message } : {}),
      ...(orgId ? { orgId } : {}),
    });
    const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
    const text =
      action === 'void'
        ? `${plural(result.done, 'pass', 'passes')} voided`
        : action === 'remove'
          ? `${plural(result.done, 'pass', 'passes')} removed from Wallet`
          : `${plural(result.done, 'email', 'emails')} queued`;
    if (action === 'send_email') toast.sent(`${text}${skipped}`);
    else toast.success(`${text}${skipped}`);
    onClear();
  }

  return (
    <section
      ref={barRef}
      aria-label="Selection"
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-safe shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-safe py-3 sm:[--wl-gutter:1.5rem]">
        <IconButton label="Clear selection" icon={<X aria-hidden />} onClick={onClear} />
        <p role="status" className="mr-auto text-sm font-medium text-fg-strong tabular-nums">
          {n} selected
        </p>
        <Button
          variant="outline"
          disabled={emailable === 0}
          iconStart={<ACTION_ICON.sendEmail aria-hidden />}
          onClick={() => setAsk('send_email')}
        >
          Send email
        </Button>
        <span title={canShare ? undefined : SHARE_HINT}>
          <Button
            variant="outline"
            disabled={!canShare}
            aria-describedby={canShare ? undefined : 'share-hint'}
            iconStart={<ACTION_ICON.bundle aria-hidden />}
            onClick={() => setSharing(true)}
          >
            Share as bundle
          </Button>
          {canShare ? null : (
            <span id="share-hint" className="sr-only">
              {SHARE_HINT}
            </span>
          )}
        </span>
        {compact ? (
          <MoreMenu>
            <DropdownMenuItem disabled={changeable === 0} onSelect={() => setAsk('void')}>
              <ACTION_ICON.void aria-hidden />
              Void
            </DropdownMenuItem>
            <DropdownMenuItem disabled={changeable === 0} onSelect={() => setAsk('remove')}>
              <ACTION_ICON.removeFromWallet aria-hidden />
              Remove from Wallet
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport}>
              <ACTION_ICON.download aria-hidden />
              Export CSV
            </DropdownMenuItem>
          </MoreMenu>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={changeable === 0}
              iconStart={<ACTION_ICON.void aria-hidden />}
              onClick={() => setAsk('void')}
            >
              Void
            </Button>
            <Button
              variant="outline"
              disabled={changeable === 0}
              iconStart={<ACTION_ICON.removeFromWallet aria-hidden />}
              onClick={() => setAsk('remove')}
            >
              Remove from Wallet
            </Button>
            <Button
              variant="outline"
              iconStart={<ACTION_ICON.download aria-hidden />}
              onClick={onExport}
            >
              Export CSV
            </Button>
          </>
        )}
      </div>
      {bundleOrgId ? (
        <BundleDialog
          open={sharing}
          onOpenChange={setSharing}
          orgId={bundleOrgId}
          passIds={ids}
          onDone={onClear}
        />
      ) : null}
      <ConfirmDialog
        open={ask === 'void'}
        onOpenChange={(o) => !o && setAsk(null)}
        {...voidConfirm(changeable)}
        destructive
        onConfirm={() => run('void')}
      />
      <RemoveDialog
        open={ask === 'remove'}
        onOpenChange={(o) => !o && setAsk(null)}
        count={changeable}
        onConfirm={(message) => run('remove', message)}
      />
      <ConfirmDialog
        open={ask === 'send_email'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Email ${plural(emailable, 'holder', 'holders')}?`}
        description={
          emailable < n
            ? `Each holder gets their pass. ${n - emailable} without a holder will be skipped.`
            : 'Each holder gets their pass.'
        }
        confirmLabel="Send email"
        onConfirm={() => run('send_email')}
      />
    </section>
  );
}
