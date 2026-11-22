import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { isApiError } from '../../../lib/errors.ts';
import { prefersReducedMotion } from '../../../lib/motion.ts';
import { Button, Callout, Dialog, DialogContent, Skeleton, toast } from '../../../ui/index.ts';
import { FirstRelease } from './first-release.tsx';
import { useReleasePlan, useReviewFlow } from './flow-api.ts';
import { PlanSummary } from './plan-summary.tsx';
import './release-strip.css';

const MODES: Mode[] = ['test', 'live'];

/** The server's own sentence for the two refusals a reviewer can hit; anything else is generic. */
function reviewError(cause: unknown): { message: string; gone: boolean } {
  if (isApiError(cause) && cause.code === 'TEMPLATE_REVIEW_NOT_FOUND')
    return { message: cause.message, gone: true };
  if (isApiError(cause) && cause.code === 'KEY_TEST_ONLY')
    return { message: cause.message, gone: false };
  return { message: cause instanceof Error ? cause.message : 'Could not approve.', gone: false };
}

export default function ReviewDialog({
  templateId,
  orgId,
  version,
  name,
  requestedBy,
  canPublish,
  onClose,
}: {
  templateId: string;
  orgId: string;
  version: string;
  name: (hash: string | null) => string;
  requestedBy: string | null;
  canPublish: boolean;
  onClose: () => void;
}) {
  const to = name(version);
  const plan = useReleasePlan(templateId, orgId, version, MODES);
  const review = useReviewFlow(templateId, orgId);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ message: string; gone: boolean }>();
  const busy = review.isPending || done;
  const modes = MODES.filter((m) => plan.data?.modes[m]);
  const first = plan.data?.fromVersion === null;

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(onClose, prefersReducedMotion() ? 0 : 500);
    return () => clearTimeout(timer);
  }, [done, onClose]);

  async function submit(release: boolean) {
    setError(undefined);
    try {
      await review.mutateAsync({ version, ...(release ? { release: true } : {}) });
      toast.success(release ? `Released ${to}` : `Approved ${to}`);
      setDone(true);
    } catch (cause) {
      setError(reviewError(cause));
    }
  }
  const off = !plan.data && !plan.isError;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={`Review ${to}`}
        description={requestedBy ? `From ${requestedBy}` : undefined}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={canPublish ? 'outline' : 'primary'}
              loading={review.isPending && !canPublish}
              disabled={busy || error?.gone}
              onClick={() => void submit(false)}
            >
              Approve
            </Button>
            {canPublish ? (
              <Button
                loading={review.isPending}
                disabled={busy || error?.gone}
                onClick={() => void submit(true)}
              >
                Approve and release
              </Button>
            ) : null}
          </>
        }
      >
        <div className="grid gap-5">
          {off ? (
            <div role="status" aria-busy className="grid gap-3">
              <span className="sr-only">Loading changes</span>
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : plan.data ? (
            <>
              <ul aria-label="Modes" className="flex flex-wrap gap-2">
                {modes.map((m) => {
                  const p = plan.data?.modes[m];
                  return p ? (
                    <li key={m} className="wl-chip" data-mode={m} data-state="idle">
                      <span className="wl-chip-mode">{m === 'test' ? 'Test' : 'Live'}</span>
                      <span className="text-fg-muted">{p.from ? name(p.from) : '—'}</span>
                      <ArrowRight aria-hidden className="size-3" />
                      <b>{to}</b>
                    </li>
                  ) : null;
                })}
              </ul>
              <FirstRelease
                templateId={templateId}
                orgId={orgId}
                version={version}
                enabled={first}
              />
              <PlanSummary plan={plan.data} templateId={templateId} orgId={orgId} diff={!first} />
            </>
          ) : (
            <p className="text-sm text-fg-muted">Changes are not available to you.</p>
          )}
          {error ? <Callout tone="danger">{error.message}</Callout> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
