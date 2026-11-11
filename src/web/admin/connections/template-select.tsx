import { FormField, Select } from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';

const NONE = '__none__';

/** The template passes are built from: chosen once, on the Mapping step or tab. */
export function TemplateSelect({
  orgId,
  value,
  disabled,
  onChange,
}: {
  orgId: string | undefined;
  value: string;
  disabled?: boolean;
  onChange: (templateId: string) => void;
}) {
  const templates = useTemplates({ orgId }, Boolean(orgId));
  return (
    <FormField label="Template" help="Passes are built from it.">
      {(c) => (
        <Select
          {...c}
          className="sm:max-w-sm"
          disabled={disabled}
          value={value || NONE}
          onValueChange={(v) => onChange(v === NONE ? '' : v)}
          options={[
            { value: NONE, label: 'None' },
            ...(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      )}
    </FormField>
  );
}
