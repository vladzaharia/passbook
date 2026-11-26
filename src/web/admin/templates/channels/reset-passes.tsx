import { useState } from 'react';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { Button } from '../../../ui/index.ts';
import {
  type LocalOperationDef,
  OperationProgress,
  useLocalOperation,
} from '../../../ui/operation/index.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { useResetPasses } from './api.ts';
import { ReviewDialog } from './review-dialog.tsx';

const COPY = TEMPLATE_BRAND_COPY.reset;
const DEF: LocalOperationDef = {
  kind: 'channels.reset',
  title: 'Reset passes',
  doneTitle: COPY.done,
  failTitle: COPY.failed,
  steps: [{ key: 'reset', label: 'Reset passes', active: 'Resetting passes' }],
};

/**
 * The foot of the channel list: how many passes carry their own choice, and Reset N passes, which
 * sends only those channels back to following the template.
 */
export function ResetPasses({
  templateId,
  orgId,
  passes,
  overrides,
  disabled,
  canReset,
}: {
  templateId: string;
  orgId: string;
  passes: number;
  overrides: Record<Channel, number>;
  /** Unsaved edits: reset what is saved, not what is drafted. */
  disabled: boolean;
  canReset: boolean;
}) {
  const zone = useOrgTimeZone(orgId);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const { operation, driver } = useLocalOperation(DEF, zone);
  const reset = useResetPasses(templateId, orgId);
  const lines = CHANNELS.filter((c) => (overrides[c] ?? 0) > 0).map((c) =>
    scanLine(COPY.line, { channel: CHANNEL_LABEL[c], n: overrides[c] ?? 0 }),
  );
  if (passes === 0 && !shown) return <p className="text-sm text-fg-muted">{COPY.none}</p>;
  async function run(total: number) {
    if (driver.snapshot().status === 'failed') driver.retry();
    setShown(true);
    driver.step('reset', { total });
    try {
      const { done, remaining } = await reset.mutateAsync((n) => driver.progress('reset', n));
      if (remaining > 0) driver.fail('reset', scanLine(COPY.partial, { done, total }));
      else {
        driver.complete('reset');
        driver.finish();
      }
    } catch {
      driver.fail('reset', COPY.failed);
    }
  }
  const busy = operation.status === 'running';
  return (
    <div className="flex flex-col gap-4">
      {passes > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg-muted">
            {passes === 1 ? COPY.one : scanLine(COPY.some, { n: passes })}
          </p>
          {canReset ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || busy}
              onClick={() => setOpen(true)}
            >
              {passes === 1 ? COPY.buttonOne : scanLine(COPY.button, { n: passes })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {shown ? (
        <OperationProgress
          operation={operation}
          zone={zone}
          onRetry={() => void run(operation.steps[0]?.total ?? passes)}
          onClose={() => setShown(false)}
        />
      ) : null}
      <ReviewDialog
        open={open}
        onOpenChange={setOpen}
        title={COPY.title}
        confirmLabel="Reset"
        lines={[...lines, COPY.body]}
        onConfirm={async () => {
          void run(passes);
        }}
      />
    </div>
  );
}
