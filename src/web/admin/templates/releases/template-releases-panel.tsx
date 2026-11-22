import { useState } from 'react';
import type {
  TemplateCandidate,
  TemplateRelease,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { Callout, Card, CardBody, ErrorState, Skeleton, toast } from '../../../ui/index.ts';
import { useReleaseActions, useReleaseLists } from './api.ts';
import { CandidateSection } from './candidates.tsx';
import { eligibleApproval, selfApproved } from './eligibility.ts';
import { ReleaseDialog, type ReleaseOperation } from './release-dialog.tsx';
import { ReleaseTimeline, timelineEntries } from './release-timeline.tsx';
import { type TemplateReleasesPanelProps, versionShort } from './types.ts';
import { WalletRows } from './wallet-rows.tsx';

export type { TemplateReleasesPanelProps } from './types.ts';

const LIVE = { mode: 'live', provider: 'apple' } as const;
const TEST = { mode: 'test', provider: 'apple' } as const;
const latest = (items: readonly TemplateRelease[]) =>
  items.reduce((max, release) => Math.max(max, release.generation), 0);

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
  release,
}: TemplateReleasesPanelProps & { orgId: string }) {
  const [provider, setProvider] = useState<TemplateReleaseProvider>('apple');
  const scope: TemplateReleaseScope = { orgId, mode, provider };
  const apple = provider === 'apple';
  const { releases, candidates } = useReleaseLists(templateId, scope);
  const liveLists = useReleaseLists(templateId, { orgId, ...LIVE });
  const testLists = useReleaseLists(templateId, { orgId, ...TEST });
  const actions = useReleaseActions(templateId, scope);
  const liveActions = useReleaseActions(templateId, { orgId, ...LIVE });
  const testActions = useReleaseActions(templateId, { orgId, ...TEST });
  const [operation, setOperation] = useState<ReleaseOperation | null>(null);
  const [error, setError] = useState<string>();
  const busy =
    actions.create.isPending ||
    actions.approve.isPending ||
    actions.publish.isPending ||
    liveActions.rollback.isPending ||
    testActions.rollback.isPending;
  const ownScope = templateOrgId === null || templateOrgId === orgId;
  const editable = ownScope && templateOrigin === 'uploaded' && templateStatus === 'active';
  const releasable =
    ownScope &&
    templateOrigin === 'uploaded' &&
    (templateStatus === 'active' ||
      (templateStatus === 'archived' && mode === 'live' && templateOrgId === orgId));
  const canPublish = capabilities.includes('templates:publish') && releasable;
  const name = (hash: string) => versionShort(versions, hash);

  async function create(version: string) {
    setError(undefined);
    try {
      await actions.create.mutateAsync({ ...scope, version });
      toast.success('Candidate created');
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
      return;
    }
    const { release: target } = selected;
    await liveActions.rollback.mutateAsync({
      orgId,
      ...LIVE,
      releaseId: target.id,
      candidateHash: target.candidateHash,
      expectedGeneration: selected.generation,
      reason,
    });
    // Test follows Live when it was following.
    const twin = testLists.releases.data?.items.find(
      (r) =>
        r.version === target.version && r.source === 'approved' && r.candidateId && r.approvalId,
    );
    if (release?.test?.state === 'following' && twin) {
      try {
        await testActions.rollback.mutateAsync({
          orgId,
          ...TEST,
          releaseId: twin.id,
          candidateHash: twin.candidateHash,
          expectedGeneration: latest(testLists.releases.data?.items ?? []),
          reason,
        });
      } catch (cause) {
        toast.error(cause, 'Live restored. Test was not');
        return;
      }
    }
    toast.success(`${name(target.version)} restored`);
  }

  const failed = [releases, candidates, liveLists.releases, testLists.releases].find(
    (q) => q.isError,
  );
  if (failed) {
    return (
      <ErrorState
        inline
        subject="template releases"
        error={failed.error}
        onRetry={() =>
          Promise.all([
            releases.refetch(),
            candidates.refetch(),
            liveLists.releases.refetch(),
            testLists.releases.refetch(),
          ])
        }
      />
    );
  }
  if (!releases.data || !candidates.data || !liveLists.releases.data || !testLists.releases.data) {
    return (
      <div role="status" aria-busy className="grid gap-2">
        <span className="sr-only">Loading releases</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const live = liveLists.releases.data;
  const liveGeneration = latest(live.items);
  const generation = latest(releases.data.items);
  const releasedCandidates = new Set(releases.data.items.map((r) => r.candidateId));
  const selfApprovals = new Set(
    candidates.data.items.flatMap((c) => c.approvals.filter(selfApproved).map((a) => a.id)),
  );
  const pending = candidates.data.items.filter((c) => !releasedCandidates.has(c.id));
  // Solo releasers use the strip; a team reviews here.
  const showCandidates = !release?.alone || pending.some(eligibleApproval);
  const restorable = (r: TemplateRelease) =>
    (r.generation < liveGeneration ||
      (templateStatus === 'archived' && r.generation === liveGeneration)) &&
    r.source === 'approved' &&
    r.candidateId !== null &&
    r.approvalId !== null &&
    r.id !== live.active?.id;
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
          active: (mode === 'live' ? live : testLists.releases.data).active ?? null,
          candidates: candidates.data.items,
        }}
      />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {templateOrigin === 'baked' ? (
        <Callout>
          Built-in releases are managed by the system. Duplicate to release your own.
        </Callout>
      ) : null}
      <ReleaseTimeline
        entries={timelineEntries(live.items, testLists.releases.data.items)}
        name={name}
        liveId={live.active?.id ?? null}
        testId={testLists.releases.data.active?.id ?? null}
        selfApprovals={selfApprovals}
        canRestore={canPublish}
        busy={busy}
        restorable={restorable}
        onRestore={(r) =>
          setOperation({ kind: 'rollback', release: r, generation: liveGeneration })
        }
      />
      {showCandidates ? (
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
          promotable={[]}
          onCreate={create}
          onPromote={async () => undefined}
          onApprove={approve}
          onPublish={(candidate, approval) =>
            setOperation({ kind: 'publish', candidate, approval, generation })
          }
        />
      ) : null}
      {operation ? (
        <ReleaseDialog
          operation={operation}
          currentGeneration={operation.kind === 'rollback' ? liveGeneration : generation}
          templateId={templateId}
          scope={operation.kind === 'rollback' ? { orgId, ...LIVE } : scope}
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
      <Card>
        <CardBody>
          <p className="text-sm text-fg-muted">Select an organization.</p>
        </CardBody>
      </Card>
    );
  if (props.templateOrgId !== null && props.templateOrgId !== props.orgId)
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-fg-muted">Select the owning organization.</p>
        </CardBody>
      </Card>
    );
  return (
    <ScopedPanel
      key={JSON.stringify([props.templateId, props.orgId, props.mode])}
      {...props}
      orgId={props.orgId}
    />
  );
}
