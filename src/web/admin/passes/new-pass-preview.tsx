import { useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { api } from '@/web/lib/api.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { scopePreviewAssets } from '@/web/lib/preview-batch.ts';
import { useMediaQuery } from '../../lib/media.ts';
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  EntityArt,
  ErrorState,
  Skeleton,
} from '../../ui/index.ts';
import { usePassSetup } from '../brand/api.ts';
import { brandingUrl } from '../orgs/queries.ts';
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

interface ReleasedPreviewInput {
  templateId: string | undefined;
  orgId: string | undefined;
  version: string | undefined;
  principalId: string | undefined;
  mode: 'live' | 'test';
  input?: FormValues | undefined;
  enabled?: boolean | undefined;
}

/** Preview only the released version in the same scope as its eligible choice. */
export function useReleasedPreview({
  templateId,
  orgId,
  version,
  principalId,
  mode,
  input,
  enabled = true,
}: ReleasedPreviewInput) {
  return useQuery({
    queryKey: [
      'admin',
      'templates',
      'issuance-preview',
      principalId,
      orgId,
      mode,
      templateId,
      version,
      input,
    ],
    queryFn: async ({ signal }) => {
      if (!templateId || !orgId || !version || !principalId)
        throw new Error('Choose an approved release.');
      return scopePreviewAssets(
        await api.post(
          `/api/v1/templates/${encodeURIComponent(templateId)}/preview`,
          PreviewResponseSchema,
          { orgId, version, ...(input === undefined ? {} : { input }) },
          { query: { orgId }, signal },
        ),
        orgId,
      );
    },
    enabled: enabled && Boolean(templateId && orgId && version && principalId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const BRAND_ASSET = /^(logo|icon)(?:@([23])x)?\.png$/;

/**
 * The organization's own logo and icon in place of the template's, for the parts the template
 * follows the organization on: what the issued pass will carry, and fresh as soon as it changes.
 */
export function brandAssetUrls(
  setup: PassSetup | undefined,
  orgId: string | undefined,
  templateId: string | undefined,
  names: readonly string[],
): Record<string, string> | undefined {
  if (!setup || !orgId) return undefined;
  const own = setup.templates.find((t) => t.id === templateId)?.ownBrand ?? [];
  const out: Record<string, string> = {};
  for (const name of names) {
    const m = BRAND_ASSET.exec(name);
    const slot = m?.[1] as 'logo' | 'icon' | undefined;
    const image = slot ? setup.brand[slot] : undefined;
    if (!m || !slot || !image?.value || image.source !== 'org' || own.includes(slot)) continue;
    out[name] = brandingUrl(orgId, slot, image.value.sha, `${m[2] ?? '2'}x`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface LivePreviewInput {
  templateId: string | undefined;
  orgId: string | undefined;
  version: string | undefined;
  principalId: string | undefined;
  mode: 'live' | 'test';
  schema: unknown;
  sample: FormValues;
  input: FormValues;
}

export interface LivePreviewState {
  templateId: string | undefined;
  preview: Preview | undefined;
  error: unknown;
  retry: () => void;
  /** The organization's logo and icon over the template's own, by asset name. */
  assetUrls: Record<string, string> | undefined;
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
  version,
  principalId,
  mode,
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
  const scopeKey = JSON.stringify([principalId, orgId, mode, templateId, version]);
  const scopedInput = useMemo(() => ({ scopeKey, input: ghosted }), [scopeKey, ghosted]);
  const debounced = useDebounced(scopedInput, 250);
  const preview = useReleasedPreview({
    templateId,
    orgId,
    version,
    principalId,
    mode,
    input: debounced.input,
    enabled: debounced.scopeKey === scopeKey,
  });
  const [dealt, setDealt] = useState(false);
  useEffect(() => {
    if (valid && !dealt) setDealt(true);
  }, [valid, dealt]);
  const setup = usePassSetup(orgId ?? '', Boolean(orgId));
  const assetUrls = useMemo(
    () => brandAssetUrls(setup.data, orgId, templateId, preview.data?.assetNames ?? []),
    [setup.data, orgId, templateId, preview.data?.assetNames],
  );
  return {
    assetUrls,
    templateId,
    preview: debounced.scopeKey === scopeKey ? preview.data : undefined,
    error: debounced.scopeKey === scopeKey && preview.isError ? preview.error : null,
    retry: () => void preview.refetch(),
    dealt,
  };
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
  const { templateId, preview, dealt, error, retry, assetUrls } = state;
  if (!templateId)
    return (
      <div className="flex aspect-[320/420] w-full max-w-xs flex-col items-center justify-center gap-2 self-center rounded-xl border border-dashed border-border-strong">
        <EntityArt name="passes" size="sm" />
      </div>
    );
  if (error) return <ErrorState inline error={error} onRetry={retry} />;
  if (!preview) return <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />;
  return (
    <div className={dealt ? undefined : 'opacity-55'} data-ghost={dealt ? undefined : ''}>
      <PassPreview
        key={dealt ? 'live' : 'ghost'}
        passJson={preview.passJson}
        assetBaseUrl={preview.assetBaseUrl}
        assetNames={preview.assetNames}
        assetUrls={assetUrls}
        enter={dealt}
        {...(transitionName ? { transitionName } : {})}
      />
    </div>
  );
}

/** The wizard stage's content: the released card and the eligible template's name. */
export function StagePreview({
  state,
  name,
  transitionName,
}: {
  state: LivePreviewState;
  name: string | undefined;
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
  if (wide) return null;
  if (state.error) return <ErrorState inline error={state.error} onRetry={state.retry} />;
  if (!state.preview) return null;
  return (
    <>
      <Card className="flex items-center gap-4 p-3">
        <div aria-hidden inert className="pointer-events-none w-12 shrink-0">
          <PassPreview
            passJson={state.preview.passJson}
            assetBaseUrl={state.preview.assetBaseUrl}
            assetNames={state.preview.assetNames}
            assetUrls={state.assetUrls}
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
