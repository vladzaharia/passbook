import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { EntityArt, Skeleton } from '../../ui/index.ts';
import { useDraftPreview } from '../templates/api.ts';
import { PassPreview } from './pass-preview.tsx';
import {
  cleanValues,
  describeSchema,
  type FormValues,
  validateValues,
} from './schema-form/index.ts';

export type Preview = z.infer<typeof PreviewResponseSchema>;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

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

/**
 * The wizard's live card, as the org's pass. Until the details are valid it shows sample values,
 * muted; it deals in once when they first are, then follows edits without motion.
 */
export function LivePreview({
  templateId,
  orgId,
  schema,
  sample,
  input,
  transitionName,
  onPreview,
}: {
  templateId: string | undefined;
  orgId: string | undefined;
  schema: unknown;
  sample: FormValues;
  input: FormValues;
  transitionName?: string | undefined;
  onPreview?: (preview: Preview | undefined) => void;
}) {
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
  useEffect(() => onPreview?.(preview.data), [preview.data, onPreview]);

  if (!templateId)
    return (
      <div className="flex aspect-[320/420] w-full max-w-xs flex-col items-center justify-center gap-2 self-center rounded-xl border border-dashed border-border-strong">
        <EntityArt name="passes" size="sm" />
      </div>
    );
  if (!preview.data)
    return <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />;
  return (
    <div className={dealt ? undefined : 'opacity-55'} data-ghost={dealt ? undefined : ''}>
      <PassPreview
        key={dealt ? 'live' : 'ghost'}
        passJson={preview.data.passJson}
        assetBaseUrl={preview.data.assetBaseUrl}
        assetNames={preview.data.assetNames}
        enter={dealt}
        {...(transitionName ? { transitionName } : {})}
      />
    </div>
  );
}
