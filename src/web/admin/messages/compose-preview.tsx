import { useMemo } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { Skeleton } from '../../ui/index.ts';
import { withGhosts } from '../passes/new-pass-preview.tsx';
import { PassPreview } from '../passes/pass-preview.tsx';
import type { FormValues } from '../passes/schema-form/index.ts';
import { useDraftPreview } from '../templates/api.ts';
import type { ComposerState } from './composer-state.ts';
import { LockScreenNotice } from './lock-screen.tsx';

type Detail = z.infer<typeof TemplateDetailSchema>;

/** Sample values with the message (or the changed inputs) applied, as the first template would build. */
function previewInput(state: ComposerState, detail: Detail | undefined): FormValues {
  if (!detail) return {};
  const sample = detail.sample as FormValues;
  const messageKey = (detail.manifest as { messaging?: { input?: string } } | null)?.messaging
    ?.input;
  const input: FormValues = { ...sample };
  if (state.kind === 'message') {
    if (messageKey) input[messageKey] = state.clearing ? '' : state.message;
  } else for (const key of state.fields) input[key] = state.values[key] ?? sample[key];
  return withGhosts(detail.inputSchema, sample, input);
}

/** The lock-screen notice and the back of the pass the message lands on. */
export function ComposePreview({
  org,
  state,
  detail,
  silent,
}: {
  org: { id: string; name: string; accent?: string | null };
  state: ComposerState;
  detail: Detail | undefined;
  silent: boolean;
}) {
  const input = useDebounced(
    useMemo(() => previewInput(state, detail), [state, detail]),
    250,
  );
  const preview = useDraftPreview(detail?.id, input, { orgId: org.id });
  return (
    <div className="flex flex-col gap-6">
      {state.kind === 'message' ? (
        <LockScreenNotice org={org} text={state.message} silent={silent} />
      ) : null}
      {!detail ? (
        <p className="rounded-xl border border-dashed border-border-strong p-6 text-center text-sm text-fg-muted">
          Choose a template to see the pass.
        </p>
      ) : preview.data ? (
        <PassPreview
          passJson={preview.data.passJson}
          assetBaseUrl={preview.data.assetBaseUrl}
          assetNames={preview.data.assetNames}
          face="back"
          still
        />
      ) : (
        <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
      )}
    </div>
  );
}
