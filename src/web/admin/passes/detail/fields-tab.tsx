import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Button,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
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
}: {
  pass: Pass;
  schema: unknown;
  manifest?: unknown;
}) {
  const qc = useQueryClient();
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
      const next = await send({ input: changedKeys(baseline.values, draft) });
      qc.setQueryData(passKeys.detail(pass.id), next);
      take(next, {});
      void qc.invalidateQueries({ queryKey: passKeys.all });
      toast.success('Saved');
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
        toast.error(error);
      } else {
        toast.error(error);
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
      } else toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pb-16">
      {conflict ? (
        <div
          role="alert"
          className="mb-4 flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm"
        >
          <p className="text-fg-strong">
            This pass changed since you opened it. Your edits are kept.
          </p>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
      ) : null}
      <SchemaForm
        schema={schema}
        value={draft}
        onChange={setDraft}
        disabled={saving}
        hiddenKeys={hiddenKeys}
        showAllErrors={showErrors}
        serverErrors={serverErrors}
        fieldSources={pass.fieldSources}
        onResetField={pass.connectionId ? (k) => void reset(k) : undefined}
      />
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(baseline.values);
          setRejected(false);
          setShowErrors(false);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </div>
  );
}
