import { type ReactNode, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { isApiError } from '@/web/lib/errors.ts';
import {
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Form,
  SaveBar,
  SkeletonRows,
  toast,
  UnsavedChangesDialog,
  useBlockedSubmit,
  useFormErrors,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { changedValues, type Draft, type SettingField, toDraft } from './fields.ts';
import { useSaveSettings, useSettings } from './queries.ts';
import { SettingRow } from './setting-row.tsx';

type Entries = z.infer<typeof SettingsListSchema>['items'];

/** Server value if set, else the server default, else empty. */
function currentValues(entries: Entries): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) out[e.key] = e.value ?? e.default;
  return out;
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

/** A change that needs a danger confirm first; Cancel puts `key` back. */
export interface SaveGuard {
  key: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
}

export interface SettingsFormProps {
  scope: string;
  fields: readonly SettingField[];
  /** Asked with the changed values before saving. */
  guard?: (values: Record<string, unknown>) => SaveGuard | null;
}

/**
 * Grouped fields are cards with a header (like org detail), label left and control right;
 * ungrouped ones stack inside the caller's card. Errors show on Save and follow the values.
 */
export function SettingsForm({ scope, fields, guard }: SettingsFormProps) {
  const query = useSettings(scope);
  const save = useSaveSettings(scope);
  const initial = useMemo(
    () => (query.data ? toDraft(fields, currentValues(query.data.items)) : undefined),
    [query.data, fields],
  );
  const [edits, setEdits] = useState<Draft>({});
  const [server, setServer] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ guard: SaveGuard; values: Record<string, unknown> }>();
  const confirmed = useRef(false);
  const draft: Draft = { ...initial, ...edits };
  const changed = initial ? changedValues(fields, draft, initial) : undefined;
  const check = useFormErrors(changed?.errors ?? {});
  // A value the server refused: shown on its field and focused like a blocked save.
  const refused = useBlockedSubmit<HTMLDivElement>();
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };
  const dirty = Boolean(initial) && fields.some((f) => draft[f.key] !== initial?.[f.key]);
  const blocker = useUnsavedChangesGuard(dirty);
  const formId = `settings-${scope}`;

  if (query.isPending) return <SkeletonRows rows={4} label="Loading settings" />;
  if (query.isError || !initial || !changed)
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  async function commit(values: Record<string, unknown>) {
    try {
      await save.mutateAsync(values);
      setEdits({});
      check.reset();
      toast.success('Settings saved');
    } catch (cause) {
      const found: Record<string, string> = {};
      if (isApiError(cause)) {
        for (const f of fields) {
          const msg = cause.fields[f.key] ?? cause.fields[`values.${f.key}`];
          if (msg) found[f.key] = msg;
        }
      }
      setServer(found);
      if (Object.keys(found).length > 0) refused.block();
      else toast.error(cause, 'Could not save');
    }
  }

  function onValid() {
    if (!changed) return;
    const g = guard?.(changed.values);
    if (g) setPending({ guard: g, values: changed.values });
    else void commit(changed.values);
  }

  const edit = (key: string, v: string | boolean) => {
    setEdits((prev) => ({ ...prev, [key]: v }));
    setServer(({ [key]: _fixed, ...rest }) => rest);
  };

  return (
    <Form id={formId} {...check.form} onValid={onValid}>
      <div ref={refused.ref} className="flex flex-col gap-6">
        {sections(fields).map((section) => {
          const rows = section.fields.map((f) => (
            <SettingRow
              key={f.key}
              field={f}
              flat={!section.title}
              value={draft[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => edit(f.key, v)}
            />
          ));
          if (!section.title)
            return (
              <div key="flat" className="flex flex-col gap-4">
                {rows}
              </div>
            );
          return (
            <Card key={section.title}>
              <CardHeader title={section.title} />
              <div className="divide-y divide-border">{rows}</div>
            </Card>
          );
        })}
      </div>
      {refused.live}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        paused={save.isPaused}
        formId={formId}
        onDiscard={() => {
          setEdits({});
          setServer({});
          check.reset();
        }}
      />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (open) return;
          // Cancel: the guarded setting goes back to what is saved.
          const key = pending?.guard.key;
          if (!confirmed.current && key) setEdits(({ [key]: _dropped, ...rest }) => rest);
          confirmed.current = false;
          setPending(undefined);
        }}
        destructive
        title={pending?.guard.title ?? ''}
        description={pending?.guard.description}
        confirmLabel={pending?.guard.confirmLabel}
        onConfirm={async () => {
          confirmed.current = true;
          if (pending) await commit(pending.values);
        }}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </Form>
  );
}
