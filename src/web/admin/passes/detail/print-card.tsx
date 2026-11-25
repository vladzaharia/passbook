import { Ban, Printer, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { channelReason } from '@/shared/copy/channels.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { reprintConfirm, voidPrintConfirm } from '../../../lib/confirms.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { useMode } from '../../../lib/mode.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { printPageUrl, usePassPaper, usePassPrints, usePrintActions } from '../print-api.ts';

/**
 * The staff print page opens in its own tab. The tab opens first, in the click, so a browser does
 * not take it for a pop-up; it moves to the page once the print exists.
 */
function openPrintPage(passId: string, mode: string, win: Window | null) {
  const url = printPageUrl(passId, mode);
  if (win) {
    win.opener = null;
    win.location.href = url;
  } else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Print, Reprint and Void print for one pass. Shown when the paper channel is on for the pass or a
 * print exists; changes need passes:operate and a pass in the current mode (`readOnly`).
 */
export function PrintCard({
  pass,
  readOnly,
  bare = false,
}: {
  pass: PassDetailDto;
  readOnly: boolean;
  /** Inside the Channels card: no card of its own. */
  bare?: boolean;
}) {
  const channels = usePassPaper(pass.id);
  const prints = usePassPrints(pass.id);
  const actions = usePrintActions(pass.id);
  const mode = useMode();
  const [ask, setAsk] = useState<'reprint' | 'void' | null>(null);
  const paper = channels.data?.effective.paper;
  const active = prints.data?.prints.find((p) => p.status === 'active');
  const voided = pass.status === 'voided' || pass.removedAt != null;
  if (channels.isPending || prints.isPending) return null;
  if (paper && !paper.on && !active && prints.data?.prints.length === 0) return null;
  const canPrint = !readOnly && !voided && paper?.on === true;
  const lastCause = prints.data?.prints[0]?.voidCause;
  const ended =
    canPrint &&
    !active &&
    (lastCause === 'pass_voided' || lastCause === 'transfer' || lastCause === 'new_code');

  async function print(replace: boolean) {
    const win = window.open('about:blank', '_blank');
    try {
      if (replace || !active) await actions.mint.mutateAsync();
      else await actions.drawn.mutateAsync();
      openPrintPage(pass.id, mode, win);
      toast.success(replace ? PRINT_COPY.reprinted : PRINT_COPY.made);
    } catch (error) {
      win?.close();
      throw error;
    }
  }
  const printFromButton = () =>
    void print(false).catch((error) => toast.error(error, PRINT_COPY.couldNotPrint));

  const body = (
    <>
      {prints.isError ? (
        <ErrorState inline error={prints.error} onRetry={() => void prints.refetch()} />
      ) : channels.isError ? (
        <ErrorState inline error={channels.error} onRetry={() => void channels.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {paper && !paper.on && paper.reason ? (
            <Callout tone="info">{channelReason('paper', paper.reason)}</Callout>
          ) : null}
          {active?.stale ? <Callout tone="warning">{PRINT_COPY.stale}</Callout> : null}
          {active ? (
            <ListRows label={PRINT_COPY.card}>
              <ListRow
                leading={<Printer aria-hidden />}
                title={PRINT_COPY.printed(active.generation)}
                pills={<StatusPill status="active" />}
                meta={formatDateTime(active.createdAt)}
              />
            </ListRows>
          ) : (
            <EmptyState
              inline
              art="stub"
              title={ended ? PRINT_COPY.againNote : PRINT_COPY.cardEmpty}
              action={
                canPrint ? (
                  <Button
                    variant="outline"
                    iconStart={<Printer aria-hidden />}
                    loading={actions.mint.isPending}
                    onClick={printFromButton}
                  >
                    {ended ? PRINT_COPY.again : PRINT_COPY.print}
                  </Button>
                ) : undefined
              }
            />
          )}
          {active && !readOnly ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                iconStart={<Printer aria-hidden />}
                disabled={!canPrint}
                onClick={printFromButton}
              >
                {PRINT_COPY.print}
              </Button>
              <Button
                variant="outline"
                iconStart={<RotateCcw aria-hidden />}
                disabled={!canPrint}
                onClick={() => setAsk('reprint')}
              >
                {PRINT_COPY.reprint}
              </Button>
              <Button
                variant="outline"
                iconStart={<Ban aria-hidden />}
                onClick={() => setAsk('void')}
              >
                {PRINT_COPY.void}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
  const dialogs = (
    <>
      <ConfirmDialog
        open={ask === 'reprint'}
        onOpenChange={(open) => !open && setAsk(null)}
        {...reprintConfirm()}
        onConfirm={() => print(true)}
      />
      <ConfirmDialog
        open={ask === 'void'}
        onOpenChange={(open) => !open && setAsk(null)}
        {...voidPrintConfirm()}
        destructive
        onConfirm={async () => {
          if (!active) return;
          await actions.void.mutateAsync(active.id);
          toast.success(PRINT_COPY.voided);
        }}
      />
    </>
  );
  if (bare)
    return (
      <div className="flex flex-col gap-4 border-t border-border pt-4">
        {body}
        {dialogs}
      </div>
    );
  return (
    <Card>
      <CardHeader title={PRINT_COPY.card} />
      <CardBody>{body}</CardBody>
      {dialogs}
    </Card>
  );
}
