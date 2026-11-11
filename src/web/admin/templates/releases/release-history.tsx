import type { TemplateRelease } from '@/shared/contracts/template-releases.ts';
import { formatDateTime } from '../../../lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  KeyValue,
  TechnicalDetails,
} from '../../../ui/index.ts';
import { ACTION_LABEL, providerModeLabel, SOURCE_LABEL } from './labels.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';

const who = (r: TemplateRelease) =>
  r.createdByName ?? (r.createdBy === null ? 'System' : 'Unknown user');

function technical(r: TemplateRelease) {
  return [
    { label: 'Release ID', value: r.id },
    { label: 'Generation', value: r.generation },
    { label: 'Version hash', value: r.version },
    { label: 'Candidate hash', value: r.candidateHash },
    { label: 'Organization ID', value: r.orgId ?? 'Shared system release' },
  ];
}

export function ReleaseHistory({
  active,
  releases,
  versions,
  generation,
  blockedMessage,
  allowHeadRollback,
  canPublish,
  busy,
  onRollback,
}: {
  active: TemplateRelease | null;
  releases: readonly TemplateRelease[];
  versions: readonly ReleaseVersion[];
  generation: number;
  blockedMessage: string;
  allowHeadRollback: boolean;
  canPublish: boolean;
  busy: boolean;
  onRollback: (release: TemplateRelease) => void;
}) {
  return (
    <Card>
      <CardHeader title="Active release" />
      <CardBody className="grid gap-4">
        {active ? (
          <>
            <KeyValue
              items={[
                { label: 'Version', value: versionLabel(versions, active.version) },
                { label: 'Published by', value: who(active) },
                { label: 'Published', value: formatDateTime(active.createdAt) },
                {
                  label: 'Provider and mode',
                  value: providerModeLabel(active.provider, active.mode),
                },
                { label: 'Source', value: SOURCE_LABEL[active.source] },
              ]}
            />
            <TechnicalDetails items={technical(active)} />
          </>
        ) : (
          <p role="status" className="text-sm text-fg-strong">
            {blockedMessage}
          </p>
        )}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-fg-strong">Release history</h3>
          {releases.length ? (
            <ul aria-label="Release history" className="grid gap-3">
              {releases.map((release) => {
                const target =
                  (release.generation < generation ||
                    (allowHeadRollback && release.generation === generation)) &&
                  release.source === 'approved' &&
                  release.candidateId !== null &&
                  release.approvalId !== null &&
                  release.id !== active?.id;
                return (
                  <li key={release.id} className="min-w-0 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-fg-strong">
                          Generation {release.generation} ·{' '}
                          {versionLabel(versions, release.version)}
                          {release.id === active?.id ? ' · Active' : ''}
                        </p>
                        <p className="text-fg-muted">
                          {ACTION_LABEL[release.action]} by {who(release)} ·{' '}
                          {formatDateTime(release.createdAt)}
                        </p>
                        <TechnicalDetails className="mt-1" items={technical(release)} />
                      </div>
                      {canPublish && target ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`Roll back to ${versionLabel(versions, release.version)} (generation ${release.generation})`}
                          onClick={() => onRollback(release)}
                        >
                          Roll back
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">No releases yet.</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
