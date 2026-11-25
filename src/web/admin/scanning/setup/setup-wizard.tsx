import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScanSetupCheck, ScanSetupPreset } from '@/shared/contracts/scan-setup-intent.ts';
import { hasErrors } from '@/shared/scan-setup-checks.ts';
import { planScanSetup } from '@/shared/scan-setup-plan.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Form,
  PageHeader,
  Skeleton,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  useWizard,
  Wizard,
} from '@/web/ui/index.ts';
import { scanningKeys } from '../queries.ts';
import { applySetup } from './api.ts';
import { DoneStep } from './done-step.tsx';
import { DoorSummary } from './door-summary.tsx';
import {
  DIRECTION_LABEL,
  type Draft,
  initialDraft,
  isPreset,
  LAYOUT_LABEL,
  presetLabel,
  type StepId,
} from './draft.ts';
import { useSetupFacts } from './facts.ts';
import { applyFix, promotable, toIntent } from './intent.ts';
import { PresetTiles } from './preset-tiles.tsx';
import { ReviewStep } from './review-step.tsx';
import { AdmitsStep } from './steps/admits-step.tsx';
import { DevicesStep } from './steps/devices-step.tsx';
import { ScannersStep } from './steps/scanners-step.tsx';
import { WhenStep } from './steps/when-step.tsx';
import { WhereStep } from './steps/where-step.tsx';
import { setupErrors, setupSteps } from './steps-model.ts';
import { deviceNames, directionsOf, doorLines } from './summary.ts';
import { useSetupPreview } from './use-preview.ts';

const CRUMBS = [{ label: 'Scanning', to: '/admin/scanning' }, { label: 'Set up' }];

function Body({
  orgId,
  preset,
  fromTemplate,
  facts,
}: {
  orgId: string;
  preset: ScanSetupPreset;
  fromTemplate: string | undefined;
  facts: ReturnType<typeof useSetupFacts>;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { ctx } = facts;
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(preset, facts.timeZone, fromTemplate ?? null),
  );
  const first = useRef(JSON.stringify(draft));
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<'build' | 'done'>('build');
  const guard = useUnsavedChangesGuard(
    phase === 'build' && JSON.stringify(draft) !== first.current,
  );
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const intent = useMemo(() => toIntent(draft, orgId), [draft, orgId]);
  const local = useMemo(() => {
    const r = planScanSetup(intent, ctx);
    return r.ok ? r.plan : undefined;
  }, [intent, ctx]);
  const directions = directionsOf(draft, local);
  const lines = doorLines(draft, ctx, local);
  const preview = useSetupPreview(intent, phase === 'build' && reviewing);
  const checks = preview.data?.plan.checks ?? [];
  const reviewProblem =
    !reviewing || preview.isPending
      ? 'Checking…'
      : preview.error
        ? 'Could not check the plan.'
        : hasErrors(checks)
          ? `Fix ${checks.filter((c) => c.level === 'error').length} error`
          : undefined;
  const errors = setupErrors(draft, reviewProblem);
  const wizard = useWizard({
    steps: setupSteps(draft, lines),
    errors,
    hints: Object.fromEntries(
      Object.entries(errors).map(([k, v]) => [k, Object.values(v ?? {})[0]]),
    ),
    fieldStep: {},
    onFinish: () => {
      setPhase('done');
      apply.mutate();
    },
  });
  const onReview = wizard.id === 'review';
  useEffect(() => {
    setReviewing(onReview);
  }, [onReview]);
  // The furthest step opened; later door lines read dimmed.
  const reached = wizard.steps.reduce((at, s, i) => (s.state === 'todo' ? at : i), 0);
  const stepIndex = (id: StepId) => wizard.steps.findIndex((s) => s.id === id);

  // One key per body: a retry of the same answers replays, new answers make a new request.
  const sent = useRef<{ body: string; key: string } | undefined>(undefined);
  const apply = useMutation({
    mutationFn: () => {
      const body = JSON.stringify(intent);
      if (sent.current?.body !== body) sent.current = { body, key: crypto.randomUUID() };
      return applySetup(intent, sent.current.key);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: scanningKeys.all }),
  });

  const namesFor = (c: ScanSetupCheck) => ({
    ...(c.fix?.kind === 'device_direction'
      ? { device: deviceNames(draft)[Number(c.fix.device.split('-').at(-1)) - 1] ?? '' }
      : {}),
    ...(c.fix?.kind === 'add_staff' && promotable(draft)
      ? { person: promotable(draft)?.name ?? '' }
      : {}),
  });
  const fix = (c: ScanSetupCheck) => c.fix && setDraft((d) => (c.fix ? applyFix(d, c.fix) : d));

  if (phase === 'done') {
    const meta = draft.devices.map((d, i) =>
      d.layout === 'customer'
        ? LAYOUT_LABEL[d.layout]
        : `${LAYOUT_LABEL[d.layout]} · ${DIRECTION_LABEL[directions[i] ?? 'in']}`,
    );
    if (apply.data)
      return (
        <DoneStep
          result={apply.data}
          deviceMeta={meta}
          crumbs={CRUMBS}
          onOpen={(sessionId) =>
            void navigate({
              to: '/admin/o/$orgId/scanning/sessions/$sessionId',
              params: { orgId, sessionId },
            })
          }
        />
      );
    return (
      <>
        <PageHeader title="Set up scanning" breadcrumbs={CRUMBS} />
        {apply.isError ? (
          <ErrorState
            error={apply.error}
            title="Could not set up scanning. Try again."
            onRetry={() => apply.mutate()}
            action={
              <Button variant="outline" onClick={() => setPhase('build')}>
                Back
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-64" aria-label="Setting up" role="status" />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Set up scanning"
        breadcrumbs={CRUMBS}
        meta={<Badge tone="accent">{presetLabel(draft.preset)}</Badge>}
      />
      <Wizard
        {...wizard.frame}
        aside={
          onReview ? undefined : (
            <DoorSummary name={draft.name} lines={lines} reached={reached} stepIndex={stepIndex} />
          )
        }
        asideLabel="Door"
        asideQuiet
        onCancel={() => void navigate({ to: '/admin/o/$orgId/scanning', params: { orgId } })}
        nextLabel={
          wizard.primary === 'finish'
            ? 'Set up'
            : wizard.primary === 'review' || wizard.id === 'devices'
              ? 'Review'
              : 'Next'
        }
      >
        <Form {...wizard.form}>
          {wizard.id === 'where' ? <WhereStep draft={draft} set={set} ctx={ctx} /> : null}
          {wizard.id === 'admits' ? <AdmitsStep draft={draft} set={set} ctx={ctx} /> : null}
          {wizard.id === 'when' ? <WhenStep draft={draft} set={set} ctx={ctx} /> : null}
          {wizard.id === 'scanners' ? <ScannersStep draft={draft} set={set} ctx={ctx} /> : null}
          {wizard.id === 'devices' ? (
            <DevicesStep draft={draft} set={set} ctx={ctx} directions={directions} />
          ) : null}
          {onReview ? (
            <ReviewStep
              name={draft.name}
              lines={lines}
              preview={preview}
              timeZone={draft.timeZone}
              onZone={(timeZone) => set({ timeZone })}
              onEdit={(s) => wizard.go(s)}
              onFix={fix}
              namesFor={namesFor}
            />
          ) : null}
        </Form>
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}

/**
 * Guided setup: five questions, Review, then Done. Without a preset in the URL it asks which one
 * first. Needs manage rights; the answers load from the same admin APIs the tabs use.
 */
export function SetupWizard({
  preset,
  fromTemplate,
}: {
  preset: string | undefined;
  fromTemplate: string | undefined;
}) {
  const scope = useOrgScope();
  const orgId = scope.orgId;
  const allowed = Boolean(orgId && scope.membership?.capabilities.includes('scanning:manage'));
  if (scope.isLoading) return <p role="status">Loading setup…</p>;
  if (scope.isError) return <ErrorState error={scope.error} onRetry={() => scope.refetch()} />;
  if (!orgId || !allowed) return <EmptyState art="lock" title="You can't set up scanning here" />;
  return (
    <Facts
      orgId={orgId}
      preset={isPreset(preset) ? preset : undefined}
      fromTemplate={fromTemplate}
    />
  );
}

function Facts({
  orgId,
  preset,
  fromTemplate,
}: {
  orgId: string;
  preset: ScanSetupPreset | undefined;
  fromTemplate: string | undefined;
}) {
  const facts = useSetupFacts(orgId);
  if (!preset)
    return (
      <>
        <PageHeader title="Set up scanning" breadcrumbs={CRUMBS} />
        <PresetTiles orgId={orgId} />
      </>
    );
  if (facts.error)
    return <ErrorState error={facts.error} subject="scanning" onRetry={facts.retry} />;
  if (!facts.ready || !facts.zoneReady)
    return (
      <>
        <PageHeader title="Set up scanning" breadcrumbs={CRUMBS} />
        <Skeleton className="h-64" aria-label="Loading setup" role="status" />
      </>
    );
  return (
    <Body
      key={`${orgId}:${preset}:${fromTemplate ?? ''}`}
      orgId={orgId}
      preset={preset}
      fromTemplate={fromTemplate}
      facts={facts}
    />
  );
}
