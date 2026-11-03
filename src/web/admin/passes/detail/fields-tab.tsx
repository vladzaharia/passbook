import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  CheckboxField,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import { useConnection } from '../../connections/api.ts';
import { passKeys } from '../api.ts';
import {
  cleanValues,
  type FormValues,
  keysBoundTo,
  pickDeclared,
  SchemaForm,
  sameValues,
  validateValues,
} from '../schema-form/index.ts';

type Pass = z.infer<typeof PassDetailSchema>;

interface Baseline {
  version: number;
  values: FormValues;
}

/** Keys whose draft value differs from the baseline; a cleared key becomes null. */
export function changedKeys(base: FormValues, draft: FormValues): FormValues {
  const out: FormValues = {};
  const a = cleanValues(base);
  const b = cleanValues(draft);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    out[key] = key in b ? b[key] : null;
  }
  return out;
}

export function FieldsTab({
  pass,
  schema,
  manifest,
  onDraft,
}: {
  pass: Pass;
  schema: unknown;
  manifest?: unknown;
  /** Unsaved values (debounced 300 ms) for the live preview; null when clean. */
  onDraft?: (draft: FormValues | null) => void;
}) {
  const qc = useQueryClient();
  const connection = useConnection(pass.connectionId ?? undefined);
  const [notify, setNotify] = useState(false);
  const voided = pass.status === 'voided';
  const snapshot = (p: Pass): Baseline => ({
    version: p.version,
    values: pickDeclared(schema, p.personalization),
  });
  const [baseline, setBaseline] = useState<Baseline>(() => snapshot(pass));
  const [draft, setDraft] = useState<FormValues>(baseline.values);
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>();

  // Void state is pass.status; a /voided input would contradict the header.
  const hiddenKeys = useMemo(() => keysBoundTo(manifest, '/voided'), [manifest]);

  const dirty = !sameValues(draft, baseline.values);
  const stale = pass.version !== baseline.version;
  const conflict = dirty && (rejected || stale);
  const guard = useUnsavedChangesGuard(dirty);

  // A newer server version replaces a clean draft; a dirty draft is kept and the conflict is offered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot only reads pass and schema
  useEffect(() => {
    if (stale && !dirty && !saving) {
      const next = snapshot(pass);
      setBaseline(next);
      setDraft(next.values);
      setRejected(false);
    }
  }, [pass, stale, dirty, saving]);

  const errors = useMemo(() => validateValues(schema, draft), [schema, draft]);

  // The preview follows the draft once typing pauses; a clean form shows the saved pass.
  useEffect(() => {
    if (!onDraft) return;
    if (!dirty) {
      onDraft(null);
      return;
    }
    const t = setTimeout(() => onDraft(cleanValues(draft)), 300);
    return () => clearTimeout(t);
  }, [draft, dirty, onDraft]);
  useEffect(() => () => onDraft?.(null), [onDraft]);

  function take(next: Pass, keep: FormValues) {
    const b = snapshot(next);
    setBaseline(b);
    setDraft({ ...b.values, ...keep });
    setRejected(false);
    setServerErrors(undefined);
  }

  async function send(body: unknown): Promise<Pass> {
    return api.patch(`/api/v1/passes/${pass.id}`, PassDetailSchema, body, {
      ifMatch: String(baseline.version),
    });
  }

  async function save() {
    if (Object.keys(errors).length > 0) return setShowErrors(true);
    setSaving(true);
    setServerErrors(undefined);
    try {
      const next = await send({
        input: changedKeys(baseline.values, draft),
        ...(notify ? { notify: true } : {}),
      });
      qc.setQueryData(passKeys.detail(pass.id), next);
      take(next, {});
      setNotify(false);
      void qc.invalidateQueries({ queryKey: passKeys.all });
      toast.success(notify ? 'Saved; holders notified' : 'Saved');
    } catch (error) {
      if (isApiError(error) && error.status === 412) {
        // Keep the draft; refetch so the banner can offer reload or merge.
        setRejected(true);
        void qc.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      } else if (isApiError(error) && Object.keys(error.fields).length > 0) {
        setServerErrors(
          Object.fromEntries(
            Object.entries(error.fields).map(([k, v]) => [k.replace(/^input\./, ''), v]),
          ),
        );
        toast.error(error, 'Could not save');
      } else {
        toast.error(error, 'Could not save');
      }
    } finally {
      setSaving(false);
    }
  }

  async function reset(key: string) {
    const mine = changedKeys(baseline.values, draft);
    delete mine[key];
    setSaving(true);
    try {
      const next = await send({ resetToConnection: [key] });
      qc.setQueryData(passKeys.detail(pass.id), next);
      take(next, mine);
      void qc.invalidateQueries({ queryKey: passKeys.all });
      toast.success('Reset to connection');
    } catch (error) {
      if (isApiError(error) && error.status === 412) {
        setRejected(true);
        void qc.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      } else toast.error(error, 'Could not reset');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-16">
      {voided ? (
        <p className="text-sm text-fg-muted">Unvoid to edit.</p>
      ) : conflict ? (
        <Callout
          tone="warning"
          title="This pass changed since you opened it"
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => take(pass, {})} disabled={!stale}>
                Reload
              </Button>
              <Button
                size="sm"
                onClick={() => take(pass, changedKeys(baseline.values, draft))}
                disabled={!stale}
              >
                Merge my edits
              </Button>
            </>
          }
        >
          Your edits are kept.
        </Callout>
      ) : null}
      <SchemaForm
        schema={schema}
        value={draft}
        onChange={setDraft}
        disabled={saving || voided}
        hiddenKeys={hiddenKeys}
        showAllErrors={showErrors}
        serverErrors={serverErrors}
        fieldSources={pass.connectionId ? pass.fieldSources : undefined}
        sourceName={connection.data?.name}
        onResetField={pass.connectionId ? (k) => void reset(k) : undefined}
      />
      <SaveBar
        dirty={dirty}
        saving={saving}
        extra={
          voided ? null : (
            <CheckboxField
              label="Notify holders"
              checked={notify}
              disabled={!dirty || saving}
              onCheckedChange={(c) => setNotify(c === true)}
            />
          )
        }
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(baseline.values);
          setRejected(false);
          setShowErrors(false);
          setNotify(false);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </div>
  );
}
