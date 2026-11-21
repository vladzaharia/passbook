import { Play } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { Json } from '@/shared/contracts/common.ts';
import type { ConnectionPreviewSchema } from '@/shared/contracts/connection-preview.ts';
import { errorMessage } from '../../lib/errors.ts';
import { useSession } from '../../lib/session.ts';
import { Badge, Button, Callout, Skeleton } from '../../ui/index.ts';
import { type CheckFilter, CheckTiles } from '../passes/import/check-tiles.tsx';
import { useReleasedPreview } from '../passes/new-pass-preview.tsx';
import { PassPreview } from '../passes/pass-preview.tsx';
import type { FormValues } from '../passes/schema-form/index.ts';

type Preview = z.infer<typeof ConnectionPreviewSchema>;
type Sample = Preview['samples'][number];

const TONE = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
  skipped: 'neutral',
  error: 'danger',
} as const;
const WORD = {
  create: 'New',
  update: 'Update',
  unchanged: 'Same',
  skipped: 'Not issued',
  error: 'Needs a fix',
} as const;
const FILTER: Record<CheckFilter, Sample['action'][]> = {
  all: ['create', 'update', 'unchanged', 'skipped', 'error'],
  create: ['create'],
  update: ['update'],
  unchanged: ['skipped'],
  errors: ['error'],
};

function SampleCard({
  templateId,
  version,
  orgId,
  input,
}: {
  templateId: string;
  /** The template's active version: a preview is of a release. */
  version: string;
  orgId: string;
  input: FormValues;
}) {
  const session = useSession();
  const q = useReleasedPreview({
    templateId,
    orgId,
    version,
    principalId: session.authed?.user.id,
    mode: 'live',
    input,
  });
  if (q.data)
    return (
      <PassPreview
        passJson={q.data.passJson}
        assetBaseUrl={q.data.assetBaseUrl}
        assetNames={q.data.assetNames}
        still
      />
    );
  return q.isError ? (
    <p className="rounded-md border border-dashed border-border-strong p-3 text-center text-xs text-fg-muted">
      No preview for this template.
    </p>
  ) : (
    <Skeleton className="aspect-[320/420] w-full" />
  );
}

/** What the next sync would do, over the first records: the import check's tiles and a sample card. */
export function FirstSync({
  preview,
  pending,
  error,
  templateId,
  version,
  orgId,
  canRun,
  onRun,
}: {
  preview: Preview | undefined;
  pending: boolean;
  error: unknown;
  templateId: string | null;
  version: string | null;
  orgId: string;
  canRun: boolean;
  onRun: () => void;
}) {
  const [filter, setFilter] = useState<CheckFilter>('all');
  const c = preview?.counts;
  const first = preview?.samples.find((s) => s.action === 'create' || s.action === 'update');
  return (
    <section aria-label="First sync" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">First sync</h3>
        {canRun ? (
          <Button
            variant="ghost"
            size="sm"
            busy="pulse"
            loading={pending}
            iconStart={<Play aria-hidden />}
            onClick={onRun}
          >
            {preview ? 'Check again' : 'Dry run'}
          </Button>
        ) : null}
      </div>
      {pending && !preview ? <Skeleton className="h-24" /> : null}
      {error ? <Callout tone="danger">{errorMessage(error)}</Callout> : null}
      {preview && !preview.ok ? (
        <Callout tone="warning">
          Could not read the source{preview.errorCode ? ` (${preview.errorCode})` : ''}.
        </Callout>
      ) : null}
      {preview?.ok && c ? (
        <>
          <p className="text-xs text-fg-muted">
            {preview.records} records from the last {preview.window.days} days
            {preview.window.excluded ? `, ${preview.window.excluded} older left out` : ''}. Nothing
            is written.
          </p>
          {preview.releaseBlocked ? (
            <Callout tone="warning">
              {preview.counts.waiting} new passes wait for an approved template release.
            </Callout>
          ) : null}
          <CheckTiles
            counts={{
              rows: preview.records,
              create: c.create,
              update: c.update,
              unchanged: c.skipped,
              errors: c.errors,
              warnings: 0,
              emailable: 0,
            }}
            sameLabel="Not issued"
            compact
            filter={filter}
            onFilter={setFilter}
          />
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {preview.samples
              .filter((s) => FILTER[filter].includes(s.action))
              .map((s) => (
                <li key={s.ref} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <code className="font-mono text-xs text-fg-strong">{s.ref}</code>
                  <Badge tone={TONE[s.action]}>{WORD[s.action]}</Badge>
                  {s.message ? <span className="text-xs text-danger">{s.message}</span> : null}
                </li>
              ))}
          </ul>
          {first && templateId && version ? (
            <div className="mx-auto w-full max-w-60">
              <SampleCard
                templateId={templateId}
                version={version}
                orgId={orgId}
                input={first.fields as Record<string, Json> as FormValues}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
