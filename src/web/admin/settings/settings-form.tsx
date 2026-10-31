import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  CheckboxField,
  ErrorState,
  FormField,
  Input,
  SaveBar,
  SkeletonRows,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { changedValues, type Draft, type SettingField, toDraft } from './fields.ts';
import { useSaveSettings, useSettings } from './queries.ts';

type Entries = z.infer<typeof SettingsListSchema>['items'];

/** Server value if set, else the server default, else empty. */
function currentValues(entries: Entries): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) out[e.key] = e.value ?? e.default;
  return out;
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: string | boolean;
  error: string | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (field.kind === 'boolean') {
    return (
      <div className="flex flex-col gap-1">
        <CheckboxField
          label={field.label}
          checked={value === true}
          onCheckedChange={(c) => onChange(c === true)}
        />
        {field.help ? <p className="ml-6 text-xs text-fg-muted">{field.help}</p> : null}
      </div>
    );
  }
  return (
    <FormField label={field.label} help={field.help} error={error}>
      {(props) => (
        <div className="flex items-center gap-2">
          {field.kind === 'color' ? (
            <input
              type="color"
              aria-label={`${field.label} picker`}
              value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#000000'}
              onChange={(e) => onChange(e.target.value)}
              className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5"
            />
          ) : null}
          <Input
            {...props}
            inputMode={field.kind === 'int' ? 'numeric' : undefined}
            className="max-w-sm"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.suffix ? <span className="text-sm text-fg-muted">{field.suffix}</span> : null}
        </div>
      )}
    </FormField>
  );
}

export interface SettingsFormProps {
  scope: string;
  fields: readonly SettingField[];
}

export function SettingsForm({ scope, fields }: SettingsFormProps) {
  const query = useSettings(scope);
  const save = useSaveSettings(scope);
  const initial = useMemo(
    () => (query.data ? toDraft(fields, currentValues(query.data.items)) : undefined),
    [query.data, fields],
  );
  const [edits, setEdits] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const draft: Draft = { ...initial, ...edits };
  const dirty = Boolean(initial) && fields.some((f) => draft[f.key] !== initial?.[f.key]);
  const guard = useUnsavedChangesGuard(dirty);

  if (query.isPending) return <SkeletonRows rows={4} label="Loading settings" />;
  if (query.isError || !initial)
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  async function onSave() {
    if (!initial) return;
    const { values, errors: local } = changedValues(fields, draft, initial);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    try {
      await save.mutateAsync(values);
      setEdits({});
      toast.success('Settings saved');
    } catch (cause) {
      const server: Record<string, string> = {};
      if (isApiError(cause)) {
        for (const f of fields) {
          const msg = cause.fields[f.key] ?? cause.fields[`values.${f.key}`];
          if (msg) server[f.key] = msg;
        }
      }
      setErrors(server);
      if (Object.keys(server).length === 0) toast.error(errorMessage(cause));
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      {fields.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          value={draft[f.key] ?? ''}
          error={errors[f.key]}
          onChange={(v) => setEdits((prev) => ({ ...prev, [f.key]: v }))}
        />
      ))}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onSave={() => void onSave()}
        onDiscard={() => {
          setEdits({});
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </form>
  );
}
