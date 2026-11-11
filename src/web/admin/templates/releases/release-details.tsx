import type {
  ReleaseChange,
  TemplateReleaseImpact,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { Badge, ErrorState, KeyValue, Skeleton } from '../../../ui/index.ts';
import { useReleaseImpact } from './api.ts';

const GROUPS = [
  ['fields', 'Fields'],
  ['images', 'Images'],
  ['barcode', 'Barcode'],
  ['colors', 'Colours'],
] as const;

const passCount = ({ count, capped }: TemplateReleaseImpact['passes']) =>
  capped ? '10,000+' : count.toLocaleString('en-US');

const KIND = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

function Change({ change }: { change: ReleaseChange }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <Badge tone={change.kind === 'removed' ? 'warning' : 'neutral'}>{KIND[change.kind]}</Badge>
      <span className="font-medium text-fg-strong">{change.label}</span>
      <span className="min-w-0 break-words text-fg-muted">
        {change.from ?? '—'} → {change.to ?? '—'}
      </span>
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
            <ul className="grid gap-1.5">
              {impact.diff[key].map((change) => (
                <Change key={`${change.kind}:${change.label}`} change={change} />
              ))}
            </ul>
            {impact.more[key] > 0 ? (
              <p className="text-fg-muted">and {impact.more[key].toLocaleString('en-US')} more</p>
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
