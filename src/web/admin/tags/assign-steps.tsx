import type { Mode } from '@/shared/contracts/common.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import {
  Callout,
  ErrorState,
  FormField,
  SegmentedControl,
  Select,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { type AssignMethod, SparePanel, TypePanel } from './assign-manual.tsx';
import type { Enrollment } from './enroll-api.ts';
import { EnrollArt } from './enroll-art.tsx';
import { endedOutcome, WaitingFace } from './enroll-face.tsx';
import { ScannerPicker } from './scanner-picker.tsx';
import { type WorksWith, WorksWithChoice } from './works-with.tsx';

/** The user page: the person has passes in several organizations, so one is picked first. */
export interface OrgChoice {
  options: readonly string[];
  value: string | undefined;
  onChange: (value: string) => void;
  /** The chosen organization's pass has loaded. */
  ready: boolean;
  error?: unknown;
  onRetry?: () => void;
}

export function OrgStep({ org, error }: { org: OrgChoice; error: string | undefined }) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Organization" error={error}>
        {(p) => (
          <Select
            {...p}
            value={org.value}
            onValueChange={org.onChange}
            placeholder="Choose"
            options={org.options.map((o) => ({ value: o, label: o }))}
          />
        )}
      </FormField>
      {org.error ? <ErrorState inline error={org.error} onRetry={org.onRetry} /> : null}
      {org.value && !org.ready && !org.error ? <SkeletonRows rows={1} label="Loading" /> : null}
    </div>
  );
}

export interface TagDraft {
  scope: WorksWith;
  method: AssignMethod;
  scannerId: string | undefined;
  typed: string;
  spareId: string | undefined;
}

export function TagStep({
  draft,
  set,
  orgId,
  passId,
  mode,
  holderName,
  hasAccount,
  fixed,
  idError,
  onScanner,
}: {
  draft: TagDraft;
  set: (patch: Partial<TagDraft>) => void;
  orgId: string;
  passId: string;
  mode: Mode;
  holderName: string;
  hasAccount: boolean;
  fixed: boolean;
  idError: string | undefined;
  onScanner: (id: string | undefined, label: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {fixed ? null : (
        <WorksWithChoice
          name={holderName}
          hasAccount={hasAccount}
          value={draft.scope}
          onChange={(scope) => set({ scope })}
        />
      )}
      <SegmentedControl
        block
        label={TAG_COPY.assign}
        value={draft.method}
        onValueChange={(method) => set({ method })}
        options={(['scanner', 'type', 'spare'] as const).map((value) => ({
          value,
          label: TAG_COPY.assignShort[value],
          title: TAG_COPY.assignMenu[value],
        }))}
      />
      {draft.method === 'scanner' ? (
        <ScannerPicker orgId={orgId} mode={mode} value={draft.scannerId} onChange={onScanner} />
      ) : draft.method === 'type' ? (
        <TypePanel value={draft.typed} error={idError} onChange={(typed) => set({ typed })} />
      ) : (
        <SparePanel
          orgId={orgId}
          passId={passId}
          binding={draft.scope === 'person' ? 'user' : 'pass'}
          value={draft.spareId}
          onChange={(spareId) => set({ spareId })}
        />
      )}
    </div>
  );
}

/** The request's life: waiting for the tap, or why it ended (its buttons are the footer's). */
export function TapStep({
  enrollment,
  scannerName,
  summary,
  voided,
}: {
  enrollment: Enrollment | undefined;
  scannerName: string;
  summary: string;
  voided: boolean;
}) {
  const ended = enrollment ? endedOutcome(enrollment, scannerName) : null;
  if (voided) return <Refused tone="danger" title={TAG_COPY.dialog.voided} />;
  if (ended) return <Refused tone={ended.tone} title={ended.title} sub={ended.sub} />;
  return enrollment ? (
    <WaitingFace enrollment={enrollment} scanner={scannerName} ios={false} summary={summary} />
  ) : (
    <EnrollArt stage="waiting" />
  );
}

function Refused({
  tone,
  title,
  sub,
}: {
  tone: 'warning' | 'danger';
  title: string;
  sub?: string | undefined;
}) {
  return (
    <div className="wl-enroll-face flex flex-col gap-4">
      <EnrollArt stage="refused" />
      <Callout tone={tone}>
        <span className="block font-medium text-fg-strong">{title}</span>
        {sub ? <span className="block">{sub}</span> : null}
      </Callout>
    </div>
  );
}
