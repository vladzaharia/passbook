import { useQueries } from '@tanstack/react-query';
import { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { api } from '@/web/lib/api.ts';
import { CheckboxField } from '@/web/ui/checkbox.tsx';
import { useOrgTemplates } from '../scanner-api.ts';

export function TemplateChoices({
  orgId,
  selected,
  onChange,
}: {
  orgId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const templates = useOrgTemplates(orgId);
  const choices =
    templates.data?.items.filter((t) => t.orgId === orgId && t.status === 'active') ?? [];
  const details = useQueries({
    queries: choices.map((t) => ({
      queryKey: ['template', t.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(`/api/v1/templates/${encodeURIComponent(t.id)}`, TemplateDetailSchema, { signal }),
      staleTime: 60_000,
    })),
  });
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Templates</legend>
      {choices.map((t, i) => {
        const manifest = details[i]?.data?.manifest as
          | { scan?: { actions?: { kind: string }[] } }
          | undefined;
        const available = Boolean(
          manifest && (!manifest.scan || manifest.scan.actions?.some((a) => a.kind === 'check_in')),
        );
        return (
          <CheckboxField
            key={t.id}
            checked={selected.includes(t.id)}
            disabled={!available}
            label={
              <>
                {t.name}
                {!available ? (
                  <span className="ml-2 text-xs text-fg-muted">
                    {details[i]?.isPending ? 'Loading…' : 'No check-in action'}
                  </span>
                ) : null}
              </>
            }
            onCheckedChange={(checked) =>
              onChange(checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))
            }
          />
        );
      })}
      {!choices.length && !templates.isPending ? (
        <p className="text-sm text-fg-muted">Add a template to this organization first.</p>
      ) : null}
    </fieldset>
  );
}
