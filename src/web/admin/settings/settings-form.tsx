import { type ReactNode, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { cn } from '@/web/lib/cn.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Card,
  ConfirmDialog,
  ErrorState,
  SaveBar,
  SkeletonRows,
  UnsavedChangesDialog,
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

export function SettingsForm({ scope, fields, guard }: SettingsFormProps) {
  const query = useSettings(scope);
  const save = useSaveSettings(scope);
  const initial = useMemo(
    () => (query.data ? toDraft(fields, currentValues(query.data.items)) : undefined),
    [query.data, fields],
  );
  const [edits, setEdits] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ guard: SaveGuard; values: Record<string, unknown> }>();
  const [summary, setSummary] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);
  const draft: Draft = { ...initial, ...edits };
  const dirty = Boolean(initial) && fields.some((f) => draft[f.key] !== initial?.[f.key]);
  const blocker = useUnsavedChangesGuard(dirty);

  if (query.isPending) return <SkeletonRows rows={4} label="Loading settings" />;
  if (query.isError || !initial)
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  /** Blocked submit: focus the first invalid field and say how many need attention. */
  function block(local: Record<string, string>) {
    const n = Object.keys(local).length;
    setSummary(`${n} ${n === 1 ? 'field needs' : 'fields need'} attention`);
    requestAnimationFrame(() => {
      const el = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function commit(values: Record<string, unknown>) {
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
      if (Object.keys(server).length > 0) block(server);
      else toast.error(errorMessage(cause));
    }
  }

  async function onSave() {
    if (!initial) return;
    const { values, errors: local } = changedValues(fields, draft, initial);
    setErrors(local);
    if (Object.keys(local).length > 0) return block(local);
    setSummary('');
    const g = guard?.(values);
    if (g) return setPending({ guard: g, values });
    await commit(values);
  }

  return (
    <form
      ref={form}
      noValidate
      className={cn('flex flex-col gap-8', dirty && 'pb-20')}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
      {sections(fields).map((section) => {
        const rows = section.fields.map((f) => (
          <SettingRow
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
            <div key="flat" className="flex flex-col gap-4">
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
        paused={save.isPaused}
        onSave={() => void onSave()}
        onDiscard={() => {
          setEdits({});
          setErrors({});
          setSummary('');
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
    </form>
  );
}
