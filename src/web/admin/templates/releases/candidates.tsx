import { useState } from 'react';
import type {
  TemplateApproval,
  TemplateCandidate,
  TemplateRelease,
} from '@/shared/contracts/template-releases.ts';
import { formatDateTime } from '../../../lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  FormField,
  KeyValue,
  Select,
  TechnicalDetails,
} from '../../../ui/index.ts';
import { eligibleApproval } from './eligibility.ts';
import { providerModeLabel, roleLabel } from './labels.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';

const UNKNOWN = 'Unknown user';

interface CandidateSectionProps {
  candidates: readonly TemplateCandidate[];
  releasedCandidates: ReadonlySet<string | null>;
  active: TemplateRelease | null;
  versions: readonly ReleaseVersion[];
  currentUserId: string | null;
  canAuthor: boolean;
  canReview: boolean;
  canPublish: boolean;
  editable: boolean;
  releasable: boolean;
  /** A create, approve, publish or rollback is in flight. */
  busy: boolean;
  onCreate: (version: string) => Promise<void>;
  onApprove: (candidate: TemplateCandidate) => Promise<void>;
  onPublish: (candidate: TemplateCandidate, approval: TemplateApproval) => void;
}

function CandidateCard({
  candidate,
  ...props
}: Omit<CandidateSectionProps, 'candidates' | 'onCreate'> & {
  candidate: TemplateCandidate;
}) {
  const approval = eligibleApproval(candidate);
  const name = versionLabel(props.versions, candidate.version);
  const selfReview =
    props.currentUserId !== null &&
    (candidate.authorId === props.currentUserId ||
      candidate.versionAuthorId === props.currentUserId);
  const alreadyPublished = props.releasedCandidates.has(candidate.id);
  const cannotReview =
    props.busy || selfReview || !props.currentUserId || alreadyPublished || Boolean(approval);
  return (
    <li className="min-w-0 rounded-md border border-border p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg-strong">{name}</h3>
          <p className="text-xs text-fg-muted">Created {formatDateTime(candidate.createdAt)}</p>
        </div>
        <span className="text-sm font-medium text-fg-muted">
          {approval ? 'Approved' : 'Awaiting approval'}
        </span>
      </div>
      <KeyValue
        items={[
          { label: 'Candidate author', value: candidate.authorName ?? UNKNOWN },
          { label: 'Version author', value: candidate.versionAuthorName ?? UNKNOWN },
          {
            label: 'Provider and mode',
            value: providerModeLabel(candidate.provider, candidate.mode),
          },
          ...candidate.approvals.map((a) => ({
            id: a.id,
            label: 'Approved by',
            value: `${a.reviewerName ?? UNKNOWN} · ${formatDateTime(a.createdAt)}`,
          })),
        ]}
      />
      <TechnicalDetails
        className="mt-3"
        items={[
          { label: 'Candidate ID', value: candidate.id },
          { label: 'Version hash', value: candidate.version },
          { label: 'Candidate hash', value: candidate.candidateHash },
          { label: 'Content hash', value: candidate.contentHash },
          { label: 'Template ID', value: candidate.templateId },
          { label: 'Organization ID', value: candidate.orgId },
          { label: 'Adapter revision', value: candidate.adapterRevision },
          {
            label: 'Adapter capabilities',
            value: candidate.adapterCapabilities.join(', ') || 'None',
          },
          { label: 'Audience policy revision', value: candidate.audiencePolicyRevision },
        ]}
      />
      <div className="mt-4 grid gap-3">
        {!approval && !selfReview ? (
          <p className="text-sm text-fg-muted">Approval required before publishing.</p>
        ) : null}
        {selfReview ? (
          <Callout tone="info">
            You cannot review a candidate or version you authored. Ask a different reviewer.
          </Callout>
        ) : null}
        {!props.currentUserId && props.canReview ? (
          <Callout tone="warning">Your identity is unavailable. Sign in again to review.</Callout>
        ) : null}
        {alreadyPublished ? (
          <p className="text-sm text-fg-muted">
            {props.active?.candidateId === candidate.id
              ? 'This candidate is the active release.'
              : 'Already released. Roll back from the history to restore it.'}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {props.canReview ? (
            <Button
              size="sm"
              variant="outline"
              disabled={cannotReview}
              aria-label={`Approve candidate for ${name}`}
              onClick={() => void props.onApprove(candidate)}
            >
              Approve
            </Button>
          ) : null}
          {props.canPublish ? (
            <Button
              size="sm"
              disabled={props.busy || !approval || alreadyPublished}
              aria-label={`Publish candidate for ${name}`}
              onClick={() => approval && props.onPublish(candidate, approval)}
            >
              Publish
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function CandidateSection(props: CandidateSectionProps) {
  const [selected, setSelected] = useState<string>();
  const chronological = [...props.versions].sort((a, b) => a.createdAt - b.createdAt);
  const options = chronological.flatMap((v) => {
    if (v.version === props.active?.version) return [];
    const name = versionLabel(props.versions, v.version);
    const failing = v.report?.ok === false;
    return [
      {
        value: v.version,
        label: failing ? `${name} · has errors` : name,
        disabled: failing,
        name,
      },
    ];
  });
  const failing = options.filter((o) => o.disabled);
  const selectedVersion = options.some((o) => o.value === selected && !o.disabled)
    ? selected
    : undefined;
  return (
    <Card>
      <CardHeader title="Release candidates" />
      <CardBody className="grid gap-4">
        {props.canAuthor && props.editable ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
            <FormField
              label="Saved version"
              help={
                failing.length
                  ? `${failing.map((o) => o.name).join(', ')} can't be a candidate: fix the validation errors and upload a new version.`
                  : undefined
              }
              className="w-full sm:max-w-sm"
            >
              {(control) => (
                <Select
                  {...control}
                  value={selectedVersion}
                  onValueChange={setSelected}
                  options={options}
                  placeholder="Choose a version"
                  disabled={!options.length || props.busy}
                />
              )}
            </FormField>
            <Button
              disabled={!selectedVersion || props.busy}
              onClick={() => selectedVersion && void props.onCreate(selectedVersion)}
            >
              Create candidate
            </Button>
          </div>
        ) : !props.canAuthor ? (
          <p className="text-sm text-fg-muted">
            Only {roleLabel('templates:author')} can create candidates.
          </p>
        ) : null}
        {props.canAuthor && props.editable && !options.length ? (
          <p className="text-sm text-fg-muted">No other saved versions. Upload a new version.</p>
        ) : null}
        {!props.canReview ? (
          <p className="text-sm text-fg-muted">
            Only {roleLabel('templates:review')} can approve candidates.
          </p>
        ) : null}
        {!props.canPublish ? (
          <p className="text-sm text-fg-muted">
            Only {roleLabel('templates:publish')} can publish.
          </p>
        ) : null}
        {props.candidates.length ? (
          <ul aria-label="Release candidates" className="grid gap-3">
            {props.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                {...props}
                canReview={props.canReview && props.editable}
                canPublish={props.canPublish && props.releasable}
                candidate={candidate}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            {props.editable ? 'No candidates yet.' : 'No candidates in this scope.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
