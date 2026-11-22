import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type InputField, inputFields } from '@/shared/issuing/fields.ts';
import { templateDetailQuery } from '../templates/api.ts';

const MAX_TEMPLATES = 5;

/** The inputs the bar can suggest: the chosen template's, else those of the org's first templates. */
export function useFindFields(
  templates: readonly { id: string }[],
  templateId: string | undefined,
  orgId: string | undefined,
): InputField[] {
  const ids = templateId ? [templateId] : templates.slice(0, MAX_TEMPLATES).map((t) => t.id);
  const details = useQueries({
    queries: ids.map((id) => ({ ...templateDetailQuery(id, orgId), enabled: Boolean(orgId) })),
  });
  const schemas = details.map((d) => d.data?.inputSchema);
  // biome-ignore lint/correctness/useExhaustiveDependencies: schemas are the data identity
  return useMemo(() => {
    const seen = new Map<string, InputField>();
    for (const schema of schemas)
      for (const f of inputFields(schema)) if (!seen.has(f.key)) seen.set(f.key, f);
    return [...seen.values()];
  }, [details.map((d) => d.dataUpdatedAt).join()]);
}
