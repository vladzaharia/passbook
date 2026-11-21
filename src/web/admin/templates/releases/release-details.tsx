import type {
  ReleaseChange,
  TemplateReleaseImpact,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { formatCount, formatExpiry } from '../../../lib/format.ts';
import { Badge, ErrorState, KeyValue, Skeleton } from '../../../ui/index.ts';
import { useReleaseImpact } from './api.ts';

const GROUPS = [
  ['fields', 'Fields'],
  ['images', 'Images'],
  ['barcode', 'Barcode'],
  ['colors', 'Colours'],
] as const;

const passCount = ({ count, capped }: TemplateReleaseImpact['passes']) =>
  capped ? '10,000+' : formatCount(count);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const plain = (value: string) => (ISO.test(value) ? formatExpiry(value) || value : value);

/** Only the side that exists: an added line has no "before", a removed one no "after". */
function changeText({ kind, from, to }: ReleaseChange): string {
  if (kind === 'added') return plain(to ?? '');
  if (kind === 'removed') return plain(from ?? '');
  return `${plain(from ?? '')} → ${plain(to ?? '')}`;
}

const KIND = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

export function ChangeList({ changes }: { changes: readonly ReleaseChange[] }) {
  return (
    <ul className="grid gap-1.5">
      {changes.map((change) => (
        <Change key={`${change.kind}:${change.label}`} change={change} />
      ))}
    </ul>
  );
}

function Change({ change }: { change: ReleaseChange }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <Badge tone={change.kind === 'removed' ? 'warning' : 'neutral'}>{KIND[change.kind]}</Badge>
      <span className="font-medium text-fg-strong">{change.label}</span>
      <span className="min-w-0 break-words text-fg-muted">{changeText(change)}</span>
    </li>
  );
}

function ImpactBody({ impact }: { impact: TemplateReleaseImpact }) {
  const groups = GROUPS.filter(([key]) => impact.diff[key].length > 0);
  return (
    <div className="grid gap-3">
      <KeyValue items={[{ label: 'Passes to update', value: passCount(impact.passes) }]} />
      {groups.length ? (
        groups.map(([key, title]) => (
          <section key={key} aria-label={title} className="grid gap-1.5 text-sm">
            <h4 className="font-semibold text-fg-strong">{title}</h4>
            <ChangeList changes={impact.diff[key]} />
            {impact.more[key] > 0 ? (
              <p className="text-fg-muted">and {formatCount(impact.more[key])} more</p>
            ) : null}
          </section>
        ))
      ) : (
        <p className="text-sm text-fg-muted">No changes from the current release.</p>
      )}
    </div>
  );
}

/** Passes affected and what changes, from the server; shown before a publish or rollback. */
export function ReleaseImpact({
  templateId,
  scope,
  version,
}: {
  templateId: string;
  scope: TemplateReleaseScope;
  version: string;
}) {
  const impact = useReleaseImpact(templateId, scope, version);
  return (
    <section aria-label="Impact" className="grid gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">Impact</h3>
      {impact.isError ? (
        <ErrorState
          inline
          subject="the impact"
          error={impact.error}
          onRetry={() => impact.refetch()}
        />
      ) : impact.data ? (
        <ImpactBody impact={impact.data} />
      ) : (
        <div role="status" aria-busy className="grid gap-2">
          <span className="sr-only">Loading impact</span>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      )}
    </section>
  );
}
