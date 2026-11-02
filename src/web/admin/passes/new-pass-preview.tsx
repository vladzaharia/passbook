import { Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { Button, Card, Dialog, DialogContent, EntityArt, Skeleton } from '../../ui/index.ts';
import { useDraftPreview } from '../templates/api.ts';
import { PassPreview } from './pass-preview.tsx';
import {
  cleanValues,
  describeSchema,
  type FormValues,
  validateValues,
} from './schema-form/index.ts';

export type Preview = z.infer<typeof PreviewResponseSchema>;

/** Empty required fields borrow the sample, so the card shows from the first frame. */
export function withGhosts(schema: unknown, sample: FormValues, input: FormValues): FormValues {
  const out = { ...cleanValues(input) };
  for (const group of describeSchema(schema))
    for (const f of group.fields)
      if (
        f.required &&
        (out[f.key] === undefined || out[f.key] === '') &&
        sample[f.key] !== undefined
      )
        out[f.key] = sample[f.key];
  return out;
}

export interface LivePreviewInput {
  templateId: string | undefined;
  orgId: string | undefined;
  schema: unknown;
  sample: FormValues;
  input: FormValues;
}

export interface LivePreviewState {
  templateId: string | undefined;
  preview: Preview | undefined;
  /** The details were valid once: the card dealt in and stops looking like a sample. */
  dealt: boolean;
}

/**
 * The wizard's live preview data. Runs whether or not the card is on screen, so Review can list
 * the preview's warnings at every width.
 */
export function useLivePreview({
  templateId,
  orgId,
  schema,
  sample,
  input,
}: LivePreviewInput): LivePreviewState {
  const valid = useMemo(
    () =>
      schema !== undefined && Object.keys(validateValues(schema, cleanValues(input))).length === 0,
    [schema, input],
  );
  const ghosted = useMemo(() => withGhosts(schema, sample, input), [schema, sample, input]);
  const debounced = useDebounced(ghosted, 250);
  const preview = useDraftPreview(templateId, debounced, { orgId });
  const [dealt, setDealt] = useState(false);
  useEffect(() => {
    if (valid && !dealt) setDealt(true);
  }, [valid, dealt]);
  return { templateId, preview: preview.data, dealt };
}

/**
 * The wizard's live card, as the org's pass. Until the details are valid it shows sample values,
 * muted; it deals in once when they first are, then follows edits without motion.
 */
export function LivePreview({
  state,
  transitionName,
}: {
  state: LivePreviewState;
  transitionName?: string | undefined;
}) {
  const { templateId, preview, dealt } = state;
  if (!templateId)
    return (
      <div className="flex aspect-[320/420] w-full max-w-xs flex-col items-center justify-center gap-2 self-center rounded-xl border border-dashed border-border-strong">
        <EntityArt name="passes" size="sm" />
      </div>
    );
  if (!preview) return <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />;
  return (
    <div className={dealt ? undefined : 'opacity-55'} data-ghost={dealt ? undefined : ''}>
      <PassPreview
        key={dealt ? 'live' : 'ghost'}
        passJson={preview.passJson}
        assetBaseUrl={preview.assetBaseUrl}
        assetNames={preview.assetNames}
        enter={dealt}
        {...(transitionName ? { transitionName } : {})}
      />
    </div>
  );
}

/**
 * The wizard stage's content: the live card centred in the slice, the template's name under it
 * and, while choosing, its description. The caption keeps its room on every step, so the card
 * never moves; a new template's caption fades in.
 */
export function StagePreview({
  state,
  name,
  description,
  transitionName,
}: {
  state: LivePreviewState;
  name: string | undefined;
  description?: string | null | undefined;
  transitionName?: string | undefined;
}) {
  return (
    <div className="mx-auto my-auto flex w-full max-w-72 flex-col gap-5">
      <LivePreview state={state} transitionName={transitionName} />
      <div
        key={state.templateId}
        className="wl-stage-swap flex min-h-18 flex-col gap-1 text-center"
      >
        {name ? <p className="text-sm font-medium text-fg-strong">{name}</p> : null}
        {name && description ? (
          <p className="line-clamp-3 text-xs text-pretty text-fg-muted">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Below 1024 the wizard has no aside: Details and Review offer the card as a compact row with
 * Show pass, as the pass detail page does on phones.
 */
export function ShowPassRow({ state, title }: { state: LivePreviewState; title: string }) {
  const wide = useMediaQuery('(min-width: 1024px)');
  const [open, setOpen] = useState(false);
  if (wide || !state.preview) return null;
  return (
    <>
      <Card className="flex items-center gap-4 p-3">
        <div aria-hidden inert className="pointer-events-none w-12 shrink-0">
          <PassPreview
            passJson={state.preview.passJson}
            assetBaseUrl={state.preview.assetBaseUrl}
            assetNames={state.preview.assetNames}
            still
          />
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg-strong">{title}</p>
        <Button
          variant="outline"
          size="sm"
          iconStart={<Eye aria-hidden />}
          onClick={() => setOpen(true)}
        >
          Show pass
        </Button>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title} size="sm">
          <div className="py-2">
            <LivePreview state={state} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
