import { X } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { voidConfirm } from '../../lib/confirms.ts';
import { Button, ConfirmDialog, IconButton, toast } from '../../ui/index.ts';
import { useBulkPassAction } from './api.ts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Fixed at the bottom while rows are selected: n selected, then Send email, Void and Export CSV.
 * Email and Void confirm with the count; Void uses the danger button.
 */
export function SelectionBar({
  ids,
  orgId,
  onClear,
  onExport,
}: {
  ids: string[];
  orgId: string | undefined;
  onClear: () => void;
  onExport: () => void;
}) {
  const bulk = useBulkPassAction();
  const [ask, setAsk] = useState<'void' | 'send_email' | null>(null);
  const n = ids.length;
  if (n === 0) return null;

  async function run(action: 'void' | 'send_email') {
    const result = await bulk.mutateAsync({ action, ids, ...(orgId ? { orgId } : {}) });
    const skipped = result.skipped.length;
    toast.success(
      action === 'void'
        ? `${plural(result.done, 'pass', 'passes')} voided`
        : `${plural(result.done, 'email', 'emails')} queued${skipped ? `, ${skipped} without a holder` : ''}`,
    );
    onClear();
  }

  return (
    <section
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
        <Button
          variant="outline"
          iconStart={<ACTION_ICON.void aria-hidden />}
          onClick={() => setAsk('void')}
        >
          Void
        </Button>
        <Button
          variant="outline"
          iconStart={<ACTION_ICON.download aria-hidden />}
          onClick={onExport}
        >
          Export CSV
        </Button>
      </div>
      <ConfirmDialog
        open={ask === 'void'}
        onOpenChange={(o) => !o && setAsk(null)}
        {...voidConfirm(n)}
        destructive
        onConfirm={() => run('void')}
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
