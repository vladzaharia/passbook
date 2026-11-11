import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { handleStaleSave } from '@/web/lib/stale-save.ts';
import {
  ConfirmDialog,
  ErrorState,
  Form,
  SaveBar,
  type SaveResult,
  SkeletonRows,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useSavedToast,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { publishUnsaved } from './drafts.ts';
import { changedValues, type Draft, type SettingField, toDraft } from './fields.ts';
import { useSaveSettings, useSettings } from './queries.ts';
import {
  BASIC_KEYS,
  SettingsFormContent,
  SettingsReviewSummary,
} from './settings-form-content.tsx';

type Entries = z.infer<typeof SettingsListSchema>['items'];

/** Server value if set, else the server default, else empty. */
function currentValues(entries: Entries): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) out[e.key] = e.value ?? e.default;
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
  /** Under the fields: a preview wants the card's width, and one toggle beside it would float. */
  aside?: (draft: Draft) => ReactNode;
}

export function SettingsForm({ scope, fields, guard, aside }: SettingsFormProps) {
  const query = useSettings(scope);
  const save = useSaveSettings(scope);
  const platform = scope === 'platform';
  const initial = useMemo(
    () => (query.data ? toDraft(fields, currentValues(query.data.items)) : undefined),
    [query.data, fields],
  );
  const [edits, setEdits] = useState<Draft>({});
  const [resets, setResets] = useState<ReadonlySet<string>>(new Set());
  const [level, setLevel] = useState<'basic' | 'advanced'>('basic');
  const [server, setServer] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Record<string, unknown>>();
  const [pending, setPending] = useState<{ guard: SaveGuard; values: Record<string, unknown> }>();
  const reviewed = useRef(false);
  // How the confirmed save ended; the form hears it once the dialog is gone, so a refused field
  // can take focus.
  const outcome = useRef<SaveResult>('failed');
  const confirmed = useRef(false);
  // A review or guarded save waits for its confirmation; this settles the Form submission.
  const settle = useRef<(result: SaveResult) => void>(undefined);
  const saved = useSavedToast();
  const draft: Draft = { ...initial, ...edits };
  const parsed = initial ? changedValues(fields, draft, initial) : undefined;
  const changed = parsed && {
    values: { ...parsed.values, ...Object.fromEntries([...resets].map((key) => [key, null])) },
    errors: Object.fromEntries(Object.entries(parsed.errors).filter(([key]) => !resets.has(key))),
  };
  const check = useFormErrors(changed?.errors ?? {});
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };
  const dirtyFields = initial
    ? fields.filter((f) => draft[f.key] !== initial[f.key] || resets.has(f.key))
    : [];
  const dirty = dirtyFields.length > 0;
  const advancedDirty = dirtyFields.filter((field) => !BASIC_KEYS[field.key]).length;
  const blocker = useUnsavedChangesGuard(dirty);
  // Org detail has two forms on one scope (support contacts, pass email): ids must differ.
  const formId = `settings-${useId()}`;
  // Views outside the form (org detail's email preview) follow its unsaved values.
  const unsaved = JSON.stringify(Object.fromEntries(dirtyFields.map((f) => [f.key, draft[f.key]])));
  useEffect(() => {
    publishUnsaved(scope, formId, JSON.parse(unsaved) as Draft);
  }, [scope, formId, unsaved]);
  useEffect(() => () => publishUnsaved(scope, formId, null), [scope, formId]);

  if (query.isPending)
    return <SkeletonRows rows={Math.min(4, fields.length)} label="Loading settings" />;
  if (query.isError || !query.data || !initial || !changed)
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const entries = query.data.items;
  const showErrors = (found: Record<string, string | undefined>) => {
    if (
      platform &&
      !Object.keys(found).some((key) => BASIC_KEYS[key] && found[key]) &&
      Object.keys(found).some((key) => !BASIC_KEYS[key] && found[key])
    )
      setLevel('advanced');
  };

  // A value the server refused shows on its field; Form focuses it like a blocked save.
  async function commit(values: Record<string, unknown>): Promise<SaveResult> {
    try {
      await save.mutateAsync(values);
      setEdits({});
      setResets(new Set());
      setServer({});
      check.reset();
      saved('Settings saved');
      return 'saved';
    } catch (cause) {
      const found: Record<string, string> = {};
      if (isApiError(cause)) {
        for (const f of fields) {
          const msg = cause.fields[f.key] ?? cause.fields[`values.${f.key}`];
          if (msg) found[f.key] = msg;
        }
      }
      if (handleStaleSave(cause, () => query.refetch())) return 'refused';
      setServer(found);
      if (Object.keys(found).length > 0) {
        showErrors(found);
        return 'refused';
      }
      toast.error(cause, 'Could not save');
      return 'failed';
    }
  }

  function onValid(): Promise<SaveResult> | undefined {
    if (!changed) return;
    const g = guard?.(changed.values);
    if (g) setPending({ guard: g, values: changed.values });
    else if (platform) setReview(changed.values);
    else return commit(changed.values);
    return new Promise((resolve) => {
      settle.current = resolve;
    });
  }

  const settled = (result: SaveResult) => {
    settle.current?.(result);
    settle.current = undefined;
  };

  const edit = (key: string, v: string | boolean) => {
    setEdits((prev) => ({ ...prev, [key]: v }));
    setResets((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setServer(({ [key]: _fixed, ...rest }) => rest);
  };

  const reset = (field: SettingField) => {
    const entry = entries.find((item) => item.key === field.key);
    if (!entry || entry.default === undefined) return;
    if (entry.updatedAt === null) {
      setEdits(({ [field.key]: _discarded, ...rest }) => rest);
    } else {
      setEdits((prev) => ({ ...prev, ...toDraft([field], { [field.key]: entry.default }) }));
    }
    setResets((prev) => {
      const next = new Set(prev);
      if (entry.updatedAt === null) next.delete(field.key);
      else next.add(field.key);
      return next;
    });
    setServer(({ [field.key]: _fixed, ...rest }) => rest);
  };

  const reviewValues = review ?? (platform ? pending?.values : undefined);
  const reviewSummary = reviewValues ? (
    <SettingsReviewSummary entries={entries} fields={fields} reviewValues={reviewValues} />
  ) : undefined;

  return (
    <Form
      id={formId}
      className={aside ? 'flex flex-col gap-6' : undefined}
      {...check.form}
      onInvalid={() => {
        check.form.onInvalid();
        showErrors(changed.errors);
      }}
      onValid={onValid}
    >
      <SettingsFormContent
        fields={fields}
        entries={entries}
        draft={draft}
        initial={initial}
        resets={resets}
        errors={errors}
        platform={platform}
        level={level}
        setLevel={setLevel}
        dirty={dirty}
        dirtyFields={dirtyFields}
        advancedDirty={advancedDirty}
        edit={edit}
        reset={reset}
      />
      {aside?.(draft)}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        paused={save.isPaused}
        formId={formId}
        extra={
          platform && dirty ? (
            <span className="text-sm text-fg-muted">
              {dirtyFields.length} {dirtyFields.length === 1 ? 'change' : 'changes'} · Not applied
              {advancedDirty ? ` · ${advancedDirty} in Advanced` : ''}
            </span>
          ) : undefined
        }
        onDiscard={() => {
          setEdits({});
          setResets(new Set());
          setServer({});
          check.reset();
        }}
      />
      <ConfirmDialog
        open={review !== undefined}
        onOpenChange={(open) => {
          if (open) return;
          settled(reviewed.current ? outcome.current : 'failed');
          reviewed.current = false;
          setReview(undefined);
        }}
        title="Review platform changes"
        confirmLabel="Save changes"
        description={reviewSummary}
        onConfirm={async () => {
          if (!review) return;
          reviewed.current = true;
          outcome.current = await commit(review);
        }}
      />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (open) return;
          // Cancel: the guarded setting goes back to what is saved.
          const key = pending?.guard.key;
          if (!confirmed.current && key) {
            setEdits(({ [key]: _dropped, ...rest }) => rest);
            setResets((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
            settled('failed');
          }
          confirmed.current = false;
          setPending(undefined);
        }}
        destructive
        title={pending?.guard.title ?? ''}
        description={
          pending && platform ? (
            <span className="block">
              <span className="block">{pending.guard.description}</span>
              <span className="mt-3 block">Confirming saves all of these changes:</span>
              {reviewSummary}
            </span>
          ) : (
            pending?.guard.description
          )
        }
        confirmLabel={pending?.guard.confirmLabel}
        onConfirm={async () => {
          confirmed.current = true;
          if (pending) settled(await commit(pending.values));
        }}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </Form>
  );
}
