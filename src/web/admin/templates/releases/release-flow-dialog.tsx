import { ArrowRight, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type {
  ReleaseDiffValue,
  ReleaseModePlan,
} from '@/shared/contracts/template-release-flow.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatCount } from '../../../lib/format.ts';
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
import { PassPreview } from '../../passes/pass-preview.tsx';
import { useTemplatePreview } from '../api.ts';
import { useReleaseFlow, useReleasePlan } from './flow-api.ts';
import { ReleaseDiff } from './release-diff.tsx';
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
  const preview = useTemplatePreview(first ? templateId : '', orgId, version);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const modes = MODES.filter((m) => plan.data?.modes[m]);
  const review = modes.some((m) => plan.data?.modes[m]?.outcome === 'review_required');
  const impact = (plan.data?.modes.live ?? plan.data?.modes.test)?.impact;
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
  const image = (v: Extract<ReleaseDiffValue, { type: 'image' }>) =>
    `/api/v1/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(v.version)}/assets/${encodeURIComponent(v.asset)}?orgId=${encodeURIComponent(orgId)}`;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={`Release ${to}`}
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
              {review ? 'Request review' : 'Release'}
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
            {first ? (
              <div className="grid justify-items-center gap-2">
                {preview.data ? (
                  <div className="w-44">
                    <PassPreview
                      passJson={preview.data.passJson}
                      assetBaseUrl={preview.data.assetBaseUrl}
                      assetNames={preview.data.assetNames}
                      still
                    />
                  </div>
                ) : (
                  <Skeleton className="h-56 w-44 rounded-xl" />
                )}
                <p className="text-sm font-medium text-fg-strong">First release</p>
              </div>
            ) : (
              <ReleaseDiff groups={plan.data.diff} image={image} />
            )}
            {impact ? (
              <p className="text-sm text-fg-muted">
                <b className="text-fg-strong">{formatCount(impact.passes.count)}</b>
                {impact.passes.capped ? '+' : ''}{' '}
                {impact.passes.count === 1 ? 'pass updates' : 'passes update'}
                {impact.devices.count > 0 ? (
                  <>
                    {' · '}
                    <b className="text-fg-strong">{formatCount(impact.devices.count)}</b> on phones
                  </>
                ) : null}
              </p>
            ) : null}
            {error ? <Callout tone="danger">{error}</Callout> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
