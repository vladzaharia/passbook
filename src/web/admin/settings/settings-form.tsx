import { type ReactNode, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { cn } from '@/web/lib/cn.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Card,
  ErrorState,
  Input,
  Label,
  SaveBar,
  SkeletonRows,
  Switch,
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
  flat,
  onChange,
}: {
  flat: boolean;
  field: SettingField;
  value: string | boolean;
  error: string | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const id = useId();
  const helpId = field.help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const label = (
    <div className="min-w-0">
      <Label htmlFor={id} className="text-fg-strong">
        {field.label}
      </Label>
      {field.help ? (
        <p id={helpId} className="mt-0.5 text-sm text-fg-muted">
          {field.help}
        </p>
      ) : null}
    </div>
  );
  let control: ReactNode;
  if (field.kind === 'boolean') {
    control = (
      <Switch
        id={id}
        aria-describedby={describedBy}
        checked={value === true}
        onCheckedChange={(c) => onChange(c)}
      />
    );
  } else {
    control = (
      <div className="flex flex-col gap-1.5">
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
            id={id}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            inputMode={field.kind === 'int' ? 'numeric' : undefined}
            className={field.kind === 'int' ? 'w-28' : 'max-w-sm'}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.suffix ? <span className="text-sm text-fg-muted">{field.suffix}</span> : null}
        </div>
        {error ? (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className={cn(
        !flat &&
          'grid gap-x-8 gap-y-2 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start',
        flat && 'flex flex-col gap-1.5',
        !flat &&
          field.kind === 'boolean' &&
          'grid-cols-[minmax(0,1fr)_auto] items-center md:grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {label}
      <div className={field.kind === 'boolean' ? 'justify-self-end' : undefined}>{control}</div>
    </div>
  );
}

/** Sections in field order; ungrouped fields share one untitled section. */
function sections(fields: readonly SettingField[]) {
  const out: { title: string | null; fields: SettingField[] }[] = [];
  for (const f of fields) {
    const title = f.group ?? null;
    const last = out[out.length - 1];
    if (last && last.title === title) last.fields.push(f);
    else out.push({ title, fields: [f] });
  }
  return out;
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
      className={cn('flex flex-col gap-8', dirty && 'pb-20')}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      {sections(fields).map((section) => {
        const rows = section.fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            flat={!section.title}
            value={draft[f.key] ?? ''}
            error={errors[f.key]}
            onChange={(v) => setEdits((prev) => ({ ...prev, [f.key]: v }))}
          />
        ));
        if (!section.title)
          return (
            <div key="flat" className="flex flex-col gap-5">
              {rows}
            </div>
          );
        return (
          <section key={section.title} aria-label={section.title} className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-fg-strong">{section.title}</h2>
            <Card className="divide-y divide-border">{rows}</Card>
          </section>
        );
      })}
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
