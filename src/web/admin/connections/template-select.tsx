import { Link } from '@tanstack/react-router';
import { FormField, Select } from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';

const NONE = '__none__';

/**
 * The template passes are built from: chosen once, on the Mapping step or tab. Only templates issue
 * passes; a connection left on a blueprint (or a removed template) asks for one.
 */
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
  const items = templates.data?.items ?? [];
  const missing = Boolean(value) && templates.isSuccess && !items.some((t) => t.id === value);
  const help = missing ? (
    'Choose a template to issue passes for new records.'
  ) : templates.isSuccess && items.length === 0 ? (
    <>
      No templates yet.{' '}
      <Link to="/admin/blueprints" className="text-accent-fg underline-offset-2 hover:underline">
        Browse blueprints
      </Link>
    </>
  ) : undefined;
  return (
    <FormField label="Template" help={help}>
      {(c) => (
        <Select
          {...c}
          className="sm:max-w-sm"
          disabled={disabled}
          value={value || NONE}
          onValueChange={(v) => onChange(v === NONE ? '' : v)}
          options={[
            { value: NONE, label: 'None' },
            ...(missing ? [{ value, label: 'Not a template' }] : []),
            ...items.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      )}
    </FormField>
  );
}
