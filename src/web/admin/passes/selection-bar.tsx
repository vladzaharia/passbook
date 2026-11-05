import { X } from 'lucide-react';
import { useState } from 'react';
import { BUNDLE_MAX_PASSES } from '@/shared/contracts/bundles.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { voidConfirm } from '../../lib/confirms.ts';
import { Button, ConfirmDialog, IconButton, toast, useBottomBar } from '../../ui/index.ts';
import { useBulkPassAction } from './api.ts';
import { BundleDialog } from './bundle-dialog.tsx';
import { RemoveDialog } from './detail/remove-dialog.tsx';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Fixed at the bottom while rows are selected: n selected, then the bulk actions.
 * Email and Void confirm with the count; Void uses the danger button.
 */
export function SelectionBar({
  ids,
  orgId,
  bundleOrgId,
  onClear,
  onExport,
}: {
  ids: string[];
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
  const n = ids.length;
  if (n === 0) return null;

  async function run(action: 'void' | 'send_email' | 'remove', message?: string) {
    const result = await bulk.mutateAsync({
      action,
      ids,
      ...(message ? { message } : {}),
      ...(orgId ? { orgId } : {}),
    });
    const skipped = result.skipped.length;
    toast.success(
      action === 'void'
        ? `${plural(result.done, 'pass', 'passes')} voided`
        : action === 'remove'
          ? `${plural(result.done, 'pass', 'passes')} removed from Wallet`
          : `${plural(result.done, 'email', 'emails')} queued${skipped ? `, ${skipped} without a holder` : ''}`,
    );
    onClear();
  }

  function share() {
    if (n > BUNDLE_MAX_PASSES || !bundleOrgId)
      toast.error('Select up to 10 passes of one organization.', 'Could not share');
    else setSharing(true);
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
          iconStart={<ACTION_ICON.sendEmail aria-hidden />}
          onClick={() => setAsk('send_email')}
        >
          Send email
        </Button>
        <Button variant="outline" iconStart={<ACTION_ICON.bundle aria-hidden />} onClick={share}>
          Share as bundle
        </Button>
        <Button
          variant="outline"
          iconStart={<ACTION_ICON.void aria-hidden />}
          onClick={() => setAsk('void')}
        >
          Void
        </Button>
        <Button
          variant="outline"
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
        {...voidConfirm(n)}
        destructive
        onConfirm={() => run('void')}
      />
      <RemoveDialog
        open={ask === 'remove'}
        onOpenChange={(o) => !o && setAsk(null)}
        count={n}
        onConfirm={(message) => run('remove', message)}
      />
      <ConfirmDialog
        open={ask === 'send_email'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Email ${plural(n, 'holder', 'holders')}?`}
        description="Each holder gets their pass. Passes without a holder are skipped."
        confirmLabel="Send email"
        onConfirm={() => run('send_email')}
      />
    </section>
  );
}
