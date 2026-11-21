import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Skeleton } from '../../../ui/index.ts';
import { useReleasedPreview } from '../new-pass-preview.tsx';
import { PassPreview } from '../pass-preview.tsx';
import type { FormValues } from '../schema-form/index.ts';

/** The template's card for one row's input, at the import's release. */
export function InputCard({
  imp,
  orgId,
  principalId,
  input,
}: {
  imp: PassImportDto;
  orgId: string;
  principalId: string | undefined;
  input: FormValues;
}) {
  const q = useReleasedPreview({
    templateId: imp.templateId,
    orgId,
    version: imp.templateVersion ?? undefined,
    principalId,
    mode: imp.mode,
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
    <span className="flex aspect-[320/420] w-full items-center justify-center rounded-md border border-dashed border-border-strong p-3 text-center text-xs text-fg-muted">
      {C.match.noPreview}
    </span>
  ) : (
    <Skeleton className="aspect-[320/420] w-full rounded-md" />
  );
}
