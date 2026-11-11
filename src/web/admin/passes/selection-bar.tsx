import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { BUNDLE_MAX_PASSES } from '@/shared/contracts/bundles.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { voidConfirm } from '../../lib/confirms.ts';
import { errorMessage, UserMessageError } from '../../lib/errors.ts';
import { BELOW_LG, useMediaQuery } from '../../lib/media.ts';
import { sessionQuery } from '../../lib/session.ts';
import {
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  IconButton,
  MoreMenu,
  toast,
  useBottomBar,
} from '../../ui/index.ts';
import { passKeys, useBulkPassAction } from './api.ts';
import { BundleDialog } from './bundle-dialog.tsx';
import { RemoveDialog } from './detail/remove-dialog.tsx';
import { fingerprint, newKey } from './format.ts';

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
  canOperate,
  bundleOrgId,
  onClear,
  onExport,
}: {
  /** The selected rows: what each action touches is counted from them. */
  picked: PassSummaryDto[];
  orgId: string | undefined;
  canOperate: boolean;
  /** The one org of the selected passes; null when they span several. */
  bundleOrgId: string | null;
  onClear: () => void;
  onExport: () => void;
}) {
  const bulk = useBulkPassAction();
  const queryClient = useQueryClient();
  const [ask, setAsk] = useState<'void' | 'send_email' | 'remove' | null>(null);
  const [sharing, setSharing] = useState(false);
  const emailKey = useRef<{ fp: string; key: string }>({ fp: '', key: newKey() });
  const barRef = useBottomBar<HTMLElement>();
  const compact = useMediaQuery(BELOW_LG);
  const ids = picked.map((p) => p.id);
  const n = ids.length;
  const changeable = picked.filter((p) => p.removedAt === null).length;
  const emailable = picked.filter((p) => p.holderEmail !== null).length;
  const operable = Boolean(canOperate && orgId && picked.every((p) => p.orgId === orgId));
  const canShare = n <= BUNDLE_MAX_PASSES && bundleOrgId !== null;
  if (n === 0) return null;

  async function run(action: 'void' | 'send_email' | 'remove', message?: string) {
    if (!operable) throw new Error('Pass operation is not available in this organization.');
    const before = queryClient.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    const stillCurrent = () => {
      const current = queryClient.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return current?.authenticated === true && current.user.id === userId;
    };
    const fp = fingerprint([...ids].sort());
    if (emailKey.current.fp !== fp) emailKey.current = { fp, key: newKey() };
    const result = await bulk
      .mutateAsync({
        action,
        ids,
        ...(action === 'send_email' ? { key: emailKey.current.key } : {}),
        ...(message ? { message } : {}),
        ...(orgId ? { orgId } : {}),
      })
      .catch(async (error: unknown) => {
        if (!stillCurrent()) return undefined;
        await queryClient.invalidateQueries({ queryKey: passKeys.all });
        if (!stillCurrent()) return undefined;
        throw new UserMessageError(
          `${errorMessage(error)} Some selected passes may already have been processed. Check their status before retrying.`,
        );
      });
    if (result) emailKey.current = { fp: '', key: newKey() };
    if (!result || !stillCurrent()) return;
    const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
    const text =
      action === 'void'
        ? `${plural(result.done, 'pass', 'passes')} processed for voiding`
        : action === 'remove'
          ? `${plural(result.done, 'pass', 'passes')} removed from Wallet`
          : `${plural(result.done, 'email', 'emails')} queued`;
    if (action === 'send_email') toast.info(`${text}${skipped}`);
    else toast.success(`${text}${skipped}`);
    if (!stillCurrent()) return;
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
          disabled={!operable || emailable === 0}
          iconStart={<ACTION_ICON.sendEmail aria-hidden />}
          onClick={() => setAsk('send_email')}
        >
          Send email
        </Button>
        <span title={canShare ? undefined : SHARE_HINT}>
          <Button
            variant="outline"
            disabled={!operable || !canShare}
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
            <DropdownMenuItem
              disabled={!operable || changeable === 0}
              onSelect={() => setAsk('void')}
            >
              <ACTION_ICON.void aria-hidden />
              Void
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!operable || changeable === 0}
              onSelect={() => setAsk('remove')}
            >
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
              disabled={!operable || changeable === 0}
              iconStart={<ACTION_ICON.void aria-hidden />}
              onClick={() => setAsk('void')}
            >
              Void
            </Button>
            <Button
              variant="outline"
              disabled={!operable || changeable === 0}
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
          open={operable && sharing}
          onOpenChange={setSharing}
          orgId={bundleOrgId}
          passIds={ids}
          onDone={onClear}
        />
      ) : null}
      <ConfirmDialog
        open={operable && ask === 'void'}
        onOpenChange={(o) => !o && setAsk(null)}
        {...voidConfirm(changeable)}
        destructive
        onConfirm={() => run('void')}
      />
      <RemoveDialog
        open={operable && ask === 'remove'}
        onOpenChange={(o) => !o && setAsk(null)}
        count={changeable}
        onConfirm={(message) => run('remove', message)}
      />
      <ConfirmDialog
        open={operable && ask === 'send_email'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Email ${plural(emailable, 'holder', 'holders')}?`}
        description={
          emailable < n
            ? `Email will be requested for eligible passes. ${n - emailable} without a holder will be skipped. Delivery is not guaranteed.`
            : 'Email will be requested for eligible passes. Delivery is not guaranteed.'
        }
        confirmLabel="Send email"
        onConfirm={() => run('send_email')}
      />
    </section>
  );
}
