import type { ReleaseDiffValue } from '@/shared/contracts/template-release-flow.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  CopyKeyValue,
  ErrorState,
  type KeyValueItem,
  Sheet,
  SheetContent,
  Skeleton,
} from '../../ui/index.ts';
import { useReleasePlan } from './releases/flow-api.ts';
import { ReleaseDiff } from './releases/release-diff.tsx';
import type { VersionReleases } from './releases/version-info.ts';

export type SheetKind = 'compare' | 'details';

interface Props {
  kind: SheetKind;
  templateId: string;
  /** The version's hash and when it was saved. */
  version: { version: string; createdAt: number };
  /** "v8": the short names. */
  name: (hash: string) => string;
  info: VersionReleases | null;
  onClose: () => void;
}

function Compare({ templateId, version, name, info }: Omit<Props, 'kind' | 'onClose'>) {
  const orgId = info?.orgId ?? '';
  const plan = useReleasePlan(templateId, orgId, version.version, ['live']);
  const image = (v: Extract<ReleaseDiffValue, { type: 'image' }>) =>
    `/api/v1/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(v.version)}/assets/${encodeURIComponent(v.asset)}?orgId=${encodeURIComponent(orgId)}`;
  if (plan.isError)
    return (
      <ErrorState inline subject="the changes" error={plan.error} onRetry={() => plan.refetch()} />
    );
  if (!plan.data)
    return (
      <div role="status" aria-busy className="grid gap-3">
        <span className="sr-only">Loading changes</span>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  return (
    <div className="grid gap-4">
      <p className="text-sm text-fg-muted">
        {name(version.version)} against {info?.live ? `${name(info.live)} (Live)` : 'Live'}
      </p>
      <ReleaseDiff groups={plan.data.diff} image={image} />
    </div>
  );
}

function Details({ version, info }: Pick<Props, 'version' | 'info'>) {
  const release = info?.releaseOf.get(version.version);
  const items: KeyValueItem[] = [
    { label: 'Version', value: version.version, copy: true },
    { label: 'Saved', value: formatDateTime(version.createdAt), mono: false },
    ...(release
      ? [
          { label: 'Released', value: formatDateTime(release.createdAt), mono: false },
          { label: 'Generation', value: release.generation },
          { label: 'Candidate', value: release.candidateHash, copy: true },
        ]
      : []),
    ...(info?.selfApproved.has(version.version)
      ? [{ label: 'Approval', value: 'Self-approved', mono: false }]
      : []),
  ];
  return <CopyKeyValue items={items} />;
}

/** One version's side sheet: what it changes against Live, or its raw ids. */
export default function VersionSheet({ kind, onClose, ...rest }: Props) {
  const title = `${rest.name(rest.version.version)} ${kind === 'compare' ? 'changes' : 'details'}`;
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={title} side="right">
        {kind === 'compare' ? <Compare {...rest} /> : <Details {...rest} />}
      </SheetContent>
    </Sheet>
  );
}
