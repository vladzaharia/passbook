import { useState } from 'react';
import type {
  TemplateRelease,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { Card, CardBody, ErrorState, Skeleton, toast } from '../../../ui/index.ts';
import { useReleaseActions, useReleaseLists } from './api.ts';
import { selfApproved } from './eligibility.ts';
import { ReleaseDialog, type ReleaseOperation } from './release-dialog.tsx';
import { type TemplateReleasesPanelProps, versionShort } from './types.ts';
import { versionReleases } from './version-info.ts';
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
  release,
  children,
}: TemplateReleasesPanelProps & { orgId: string }) {
  const [provider, setProvider] = useState<TemplateReleaseProvider>('apple');
  const scope: TemplateReleaseScope = { orgId, mode, provider };
  const { releases, candidates } = useReleaseLists(templateId, scope);
  const liveLists = useReleaseLists(templateId, { orgId, ...LIVE });
  const testLists = useReleaseLists(templateId, { orgId, ...TEST });
  const liveActions = useReleaseActions(templateId, { orgId, ...LIVE });
  const testActions = useReleaseActions(templateId, { orgId, ...TEST });
  const [operation, setOperation] = useState<ReleaseOperation | null>(null);
  const busy = liveActions.rollback.isPending || testActions.rollback.isPending;
  const ownScope = templateOrgId === null || templateOrgId === orgId;
  const releasable =
    ownScope &&
    templateOrigin === 'uploaded' &&
    (templateStatus === 'active' ||
      (templateStatus === 'archived' && mode === 'live' && templateOrgId === orgId));
  const canPublish = capabilities.includes('templates:publish') && releasable;
  const name = (hash: string) => versionShort(versions, hash);

  async function confirm(selected: ReleaseOperation, reason: string) {
    if (selected.kind !== 'rollback') return;
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
      <div className="grid gap-4">
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
        {children?.(null)}
      </div>
    );
  }
  if (!releases.data || !candidates.data || !liveLists.releases.data || !testLists.releases.data) {
    return (
      <div className="grid gap-4">
        <div role="status" aria-busy className="grid gap-2">
          <span className="sr-only">Loading releases</span>
          <Skeleton className="h-24 w-full" />
        </div>
        {children?.(null)}
      </div>
    );
  }
  const live = liveLists.releases.data;
  const liveGeneration = latest(live.items);
  const selfApprovals = new Set(
    candidates.data.items.flatMap((c) => c.approvals.filter(selfApproved).map((a) => a.id)),
  );
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
        capabilities={capabilities}
        alone={release?.alone === true}
        apple={{
          active: (mode === 'live' ? live : testLists.releases.data).active ?? null,
          candidates: candidates.data.items,
        }}
      />
      {children?.(
        versionReleases({
          orgId,
          mode,
          live,
          test: testLists.releases.data,
          selfApprovals,
          restorable,
          onRestore: canPublish
            ? (r) => setOperation({ kind: 'rollback', release: r, generation: liveGeneration })
            : null,
          busy,
        }),
      )}
      {operation ? (
        <ReleaseDialog
          operation={operation}
          currentGeneration={liveGeneration}
          templateId={templateId}
          scope={{ orgId, ...LIVE }}
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
  const { orgId } = props;
  const note = !orgId
    ? 'Select an organization.'
    : props.templateOrgId !== null && props.templateOrgId !== orgId
      ? 'Select the owning organization.'
      : null;
  if (note || !orgId)
    return (
      <div className="grid gap-4">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-muted">{note ?? 'Select an organization.'}</p>
          </CardBody>
        </Card>
        {props.children?.(null)}
      </div>
    );
  return (
    <ScopedPanel
      key={JSON.stringify([props.templateId, props.orgId, props.mode])}
      {...props}
      orgId={orgId}
    />
  );
}
