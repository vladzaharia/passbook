import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Badge, Button, Skeleton } from '../../../ui/index.ts';
import { useReleasedPreview } from '../new-pass-preview.tsx';
import { PassPreview } from '../pass-preview.tsx';
import type { FormValues } from '../schema-form/index.ts';

const FIRST = 4;
type Preview = PassImportDto['previews'][number];

function PreviewCard({
  imp,
  orgId,
  principalId,
  preview,
}: {
  imp: PassImportDto;
  orgId: string;
  principalId: string | undefined;
  preview: Preview;
}) {
  const q = useReleasedPreview({
    templateId: imp.templateId,
    orgId,
    version: imp.templateVersion ?? undefined,
    principalId,
    mode: imp.mode,
    input: preview.input as FormValues,
  });
  return (
    <li className="flex w-40 shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <Badge tone={preview.action === 'create' ? 'success' : 'info'}>
          {preview.action === 'create' ? 'New' : 'Update'}
        </Badge>
        <span>Row {preview.row}</span>
      </div>
      {q.data ? (
        <PassPreview
          passJson={q.data.passJson}
          assetBaseUrl={q.data.assetBaseUrl}
          assetNames={q.data.assetNames}
          still
        />
      ) : q.isError ? (
        <span className="block aspect-[320/420] w-full rounded-md border border-border" />
      ) : (
        <Skeleton className="aspect-[320/420] w-full rounded-md" />
      )}
    </li>
  );
}

/** The first rows as passes, from the template and the planned input. */
export function Previews({
  imp,
  orgId,
  principalId,
}: {
  imp: PassImportDto;
  orgId: string;
  principalId: string | undefined;
}) {
  const [all, setAll] = useState(false);
  if (imp.previews.length === 0) return null;
  const shown = all ? imp.previews : imp.previews.slice(0, FIRST);
  return (
    <section aria-label={C.check.previews} className="flex flex-col gap-3">
      <ul className="flex gap-4 overflow-x-auto pb-2">
        {shown.map((p) => (
          <PreviewCard key={p.row} imp={imp} orgId={orgId} principalId={principalId} preview={p} />
        ))}
      </ul>
      {!all && imp.previews.length > FIRST ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => setAll(true)}>
            {C.check.showAll} ({imp.previews.length})
          </Button>
        </div>
      ) : null}
    </section>
  );
}
