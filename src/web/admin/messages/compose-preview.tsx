import { useMemo } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { Skeleton } from '../../ui/index.ts';
import { withGhosts } from '../passes/new-pass-preview.tsx';
import { assetMap, PassPreview } from '../passes/pass-preview.tsx';
import type { FormValues } from '../passes/schema-form/index.ts';
import { useDraftPreview } from '../templates/api.ts';
import type { ComposerState } from './composer-state.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { patchRows } from './patch-view.ts';

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
  // The notice carries the pass's own icon and the name its pass.json gives the organization.
  const icons = preview.data ? assetMap(preview.data.assetBaseUrl, preview.data.assetNames) : {};
  const iconUrl = icons['icon@2x.png'] ?? icons['icon.png'];
  const named = {
    ...org,
    name:
      (preview.data?.passJson as { organizationName?: string } | undefined)?.organizationName ??
      org.name,
  };
  // Wallet shows "<Label> is now <value>" for each changed field.
  const changes =
    detail && state.kind === 'change' ? patchRows(detail.inputSchema, state.values) : [];
  return (
    <div className="flex flex-col gap-6">
      {state.kind === 'message' ? (
        <LockScreenNotice
          org={named}
          text={state.clearing ? '' : state.message}
          silent={silent}
          iconUrl={iconUrl}
        />
      ) : (
        state.fields.flatMap((key) => {
          const row = changes.find((r) => r.key === key);
          return row
            ? [
                <LockScreenNotice
                  key={key}
                  org={named}
                  text={`${row.label} is now ${row.value}`}
                  silent={silent}
                  iconUrl={iconUrl}
                />,
              ]
            : [];
        })
      )}
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
