import { ArrowRight, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { ReleaseModePlan } from '@/shared/contracts/template-release-flow.ts';
import { TEMPLATE_REVIEW_COPY } from '@/shared/copy/template-review.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { prefersReducedMotion } from '../../../lib/motion.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  ErrorState,
  Skeleton,
  toast,
} from '../../../ui/index.ts';
import { FirstRelease } from './first-release.tsx';
import { useReleaseFlow, useReleasePlan } from './flow-api.ts';
import { PlanSummary } from './plan-summary.tsx';
import './release-strip.css';

const MODES: Mode[] = ['test', 'live'];
const MODE_NAME = { test: 'Test', live: 'Live' } as const;

function chipText(mode: Mode, plan: ReleaseModePlan, to: string) {
  if (plan.outcome === 'current') return `${MODE_NAME[mode]} ${to} already`;
  if (plan.outcome === 'kept') return `${MODE_NAME[mode]} stays`;
  return null;
}

function Chip({
  mode,
  plan,
  name,
  to,
  state,
}: {
  mode: Mode;
  plan: ReleaseModePlan;
  name: (hash: string | null) => string;
  to: string;
  state: 'idle' | 'filling' | 'done';
}) {
  const text = chipText(mode, plan, to);
  return (
    <li
      className="wl-chip"
      data-mode={mode}
      data-state={state}
      data-order={mode === 'live' ? 1 : 0}
    >
      {text ? (
        <span>{text}</span>
      ) : (
        <>
          <span className="wl-chip-mode">{MODE_NAME[mode]}</span>
          <span className="text-fg-muted">{plan.from ? name(plan.from) : '—'}</span>
          <ArrowRight aria-hidden className="size-3" />
          <b>{to}</b>
        </>
      )}
      {state === 'done' ? <Check aria-hidden className="size-3.5" /> : null}
    </li>
  );
}

export default function ReleaseFlowDialog({
  templateId,
  orgId,
  version,
  name,
  onClose,
}: {
  templateId: string;
  orgId: string;
  version: string;
  name: (hash: string | null) => string;
  onClose: () => void;
}) {
  const to = name(version);
  const plan = useReleasePlan(templateId, orgId, version, MODES);
  const flow = useReleaseFlow(templateId, orgId);
  const first = plan.data?.fromVersion === null;
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const modes = MODES.filter((m) => plan.data?.modes[m]);
  const review = modes.some((m) => plan.data?.modes[m]?.outcome === 'review_required');
  const sole = modes.some((m) => {
    const approval = plan.data?.modes[m]?.approval;
    return approval?.kind === 'sole' && approval.action === 'write';
  });
  const busy = flow.isPending || done;

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(onClose, prefersReducedMotion() ? 0 : 700);
    return () => clearTimeout(timer);
  }, [done, onClose]);

  async function submit() {
    setError(undefined);
    try {
      await flow.mutateAsync({ version, modes: MODES, ...(review ? { request: true } : {}) });
      toast.success(review ? 'Review requested' : `Released ${to}`);
      setDone(true);
    } catch (cause) {
      setError(errorMessage(cause));
      void plan.refetch();
    }
  }
  const chipState = done ? 'done' : flow.isPending ? 'filling' : 'idle';
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={review ? `Request review of ${to}` : `Release ${to}`}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={flow.isPending}
              disabled={!plan.data || busy}
              onClick={() => void submit()}
            >
              {review ? 'Request review' : sole ? TEMPLATE_REVIEW_COPY.sole.action : 'Release'}
            </Button>
          </>
        }
      >
        {plan.isError ? (
          <ErrorState
            inline
            subject="the release"
            error={plan.error}
            onRetry={() => plan.refetch()}
          />
        ) : !plan.data ? (
          <div role="status" aria-busy className="grid gap-3">
            <span className="sr-only">Loading release</span>
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="grid gap-5">
            <ul aria-label="Modes" className="flex flex-wrap gap-2">
              {modes.map((m) => {
                const p = plan.data?.modes[m];
                return p ? (
                  <Chip key={m} mode={m} plan={p} name={name} to={to} state={chipState} />
                ) : null;
              })}
            </ul>
            <FirstRelease templateId={templateId} orgId={orgId} version={version} enabled={first} />
            <PlanSummary plan={plan.data} templateId={templateId} orgId={orgId} diff={!first} />
            {sole ? <Callout>{TEMPLATE_REVIEW_COPY.sole.note}</Callout> : null}
            {error ? <Callout tone="danger">{error}</Callout> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
