import { useState } from 'react';
import type {
  TemplateCandidate,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { Callout, Card, CardBody, ErrorState, Skeleton, toast } from '../../../ui/index.ts';
import { useReleaseActions, useReleaseLists } from './api.ts';
import { CandidateSection } from './candidates.tsx';
import { eligibleApproval, selfApproved } from './eligibility.ts';
import { PROVIDER } from './labels.ts';
import { ReleaseDialog, type ReleaseOperation } from './release-dialog.tsx';
import { ReleaseHistory } from './release-history.tsx';
import type { TemplateReleasesPanelProps } from './types.ts';
import { WalletRows } from './wallet-rows.tsx';

export type { TemplateReleasesPanelProps } from './types.ts';

function ScopedPanel({
  templateId,
  templateOrigin,
  templateStatus,
  templateOrgId,
  orgId,
  mode,
  versions,
  capabilities,
  currentUserId,
}: TemplateReleasesPanelProps & { orgId: string }) {
  const [provider, setProvider] = useState<TemplateReleaseProvider>('apple');
  const scope: TemplateReleaseScope = { orgId, mode, provider };
  const apple = provider === 'apple';
  const { releases, candidates } = useReleaseLists(templateId, scope);
  const appleLists = useReleaseLists(templateId, { orgId, mode, provider: 'apple' });
  const actions = useReleaseActions(templateId, scope);
  const [operation, setOperation] = useState<ReleaseOperation | null>(null);
  const [error, setError] = useState<string>();
  const busy =
    actions.create.isPending ||
    actions.promote.isPending ||
    actions.approve.isPending ||
    actions.publish.isPending ||
    actions.rollback.isPending;
  const ownScope = templateOrgId === null || templateOrgId === orgId;
  const editable = ownScope && templateOrigin === 'uploaded' && templateStatus === 'active';
  const releasable =
    ownScope &&
    templateOrigin === 'uploaded' &&
    (templateStatus === 'active' ||
      (templateStatus === 'archived' && mode === 'live' && templateOrgId === orgId));
  const canPublish = capabilities.includes('templates:publish') && releasable;

  async function create(version: string) {
    setError(undefined);
    try {
      await actions.create.mutateAsync({ ...scope, version });
      toast.success('Candidate created');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function promote(version: string) {
    setError(undefined);
    try {
      await actions.promote.mutateAsync({ orgId, mode: 'live', provider: 'apple', version });
      toast.success('Candidate created from Test');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function approve(candidate: TemplateCandidate, alone: boolean) {
    setError(undefined);
    try {
      await actions.approve.mutateAsync({
        candidateId: candidate.id,
        body: { ...scope, candidateHash: candidate.candidateHash, ...(alone ? { alone } : {}) },
      });
      toast.success('Candidate approved');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function confirm(selected: ReleaseOperation, reason: string) {
    setError(undefined);
    if (selected.kind === 'publish') {
      await actions.publish.mutateAsync({
        ...scope,
        candidateId: selected.candidate.id,
        approvalId: selected.approval.id,
        candidateHash: selected.candidate.candidateHash,
        expectedGeneration: selected.generation,
      });
      toast.success('Release published');
    } else {
      await actions.rollback.mutateAsync({
        ...scope,
        releaseId: selected.release.id,
        candidateHash: selected.release.candidateHash,
        expectedGeneration: selected.generation,
        reason,
      });
      toast.success('Rollback published');
    }
  }

  if (releases.isError || candidates.isError) {
    return (
      <div className="grid gap-4">
        <ErrorState
          inline
          subject="template releases"
          error={releases.error ?? candidates.error}
          onRetry={() => Promise.all([releases.refetch(), candidates.refetch()])}
        />
      </div>
    );
  }
  if (!releases.data || !candidates.data) {
    return (
      <div className="grid gap-4">
        <div role="status" aria-busy className="grid gap-2">
          <span className="sr-only">Loading releases and candidates</span>
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }
  // The effective head can be null even if an older, now invalid head occupies a generation.
  const generation = releases.data.items.reduce(
    (latest, release) => Math.max(latest, release.generation),
    0,
  );
  const releasedCandidates = new Set(releases.data.items.map((release) => release.candidateId));
  const pending = candidates.data.items.filter(
    (candidate) => !releasedCandidates.has(candidate.id),
  );
  const selfApprovals = new Set(
    candidates.data.items.flatMap((c) => c.approvals.filter(selfApproved).map((a) => a.id)),
  );
  const nextStep = pending.some(eligibleApproval)
    ? 'A publisher can release an approved candidate below.'
    : pending.length
      ? 'A different reviewer must approve a candidate, or the only reviewer approves their own. Then a publisher releases it.'
      : 'Create a candidate from a saved version, get it approved, then publish it.';
  const blocked = !apple
    ? `${PROVIDER[provider]} Wallet has no release.`
    : templateOrigin === 'baked'
      ? 'No active system release, so issuing passes is blocked. Ask a platform administrator.'
      : templateStatus !== 'active'
        ? 'No active release.'
        : `No active release for this organization and mode, so issuing passes is blocked. ${nextStep}`;
  return (
    <div className="grid gap-4">
      <WalletRows
        templateId={templateId}
        orgId={orgId}
        mode={mode}
        versions={versions}
        selected={provider}
        onSelect={setProvider}
        apple={{
          active: appleLists.releases.data?.active ?? null,
          candidates: appleLists.candidates.data?.items ?? [],
        }}
      />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {templateOrigin === 'baked' ? (
        <Callout>
          Built-in releases are managed by the system. Duplicate to release your own.
        </Callout>
      ) : null}
      <ReleaseHistory
        active={releases.data.active}
        releases={releases.data.items}
        versions={versions}
        generation={generation}
        selfApprovals={selfApprovals}
        blockedMessage={blocked}
        allowHeadRollback={templateStatus === 'archived' && releasable}
        canPublish={canPublish}
        busy={busy}
        onRollback={(release) => setOperation({ kind: 'rollback', release, generation })}
      />
      <CandidateSection
        candidates={candidates.data.items}
        releasedCandidates={releasedCandidates}
        active={releases.data.active}
        versions={versions}
        currentUserId={currentUserId}
        canAuthor={apple && capabilities.includes('templates:author')}
        canReview={capabilities.includes('templates:review')}
        canPublish={capabilities.includes('templates:publish')}
        editable={editable}
        releasable={releasable}
        busy={busy}
        promotable={apple ? (releases.data.promotable ?? []) : []}
        onCreate={create}
        onPromote={promote}
        onApprove={approve}
        onPublish={(candidate, approval) =>
          setOperation({ kind: 'publish', candidate, approval, generation })
        }
      />
      {operation ? (
        <ReleaseDialog
          operation={operation}
          currentGeneration={generation}
          templateId={templateId}
          scope={scope}
          versions={versions}
          available={canPublish}
          busy={busy}
          onClose={() => setOperation(null)}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  );
}

/** Mount on the template detail page with the selected organization's capabilities. */
export function TemplateReleasesPanel(props: TemplateReleasesPanelProps) {
  if (!props.orgId)
    return (
      <div className="grid gap-4">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-muted">Select an organization.</p>
          </CardBody>
        </Card>
      </div>
    );
  if (props.templateOrgId !== null && props.templateOrgId !== props.orgId)
    return (
      <div className="grid gap-4">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-muted">Select the owning organization.</p>
          </CardBody>
        </Card>
      </div>
    );
  return (
    <ScopedPanel
      key={JSON.stringify([props.templateId, props.orgId, props.mode])}
      {...props}
      orgId={props.orgId}
    />
  );
}
