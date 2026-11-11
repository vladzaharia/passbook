import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import type { z } from 'zod';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  CheckboxField,
  Form,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import { useConnection } from '../../connections/api.ts';
import { canMutatePass, passKeys, passMutationPrincipal } from '../api.ts';
import type { PassActionRunner } from '../pass-actions.tsx';
import {
  cleanValues,
  type FormValues,
  keysBoundTo,
  pickDeclared,
  SchemaForm,
  sameValues,
  validateValues,
} from '../schema-form/index.ts';
import { BudgetNote } from './budget-note.tsx';

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
  runner,
  readOnly,
}: {
  pass: Pass;
  schema: unknown;
  manifest?: unknown;
  /** Unsaved values (debounced 300 ms) for the live preview; null when clean. */
  onDraft?: (draft: FormValues | null) => void;
  /** Restore for a removed pass; the header's runs the same action. */
  runner?: PassActionRunner;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const currentPrincipal = () => passMutationPrincipal(qc);
  const connection = useConnection(pass.connectionId ?? undefined);
  const [notify, setNotify] = useState(false);
  const removed = pass.removedAt !== null;
  const voided = pass.status === 'voided';
  const locked = voided || readOnly;
  const snapshot = (p: Pass): Baseline => ({
    version: p.version,
    values: pickDeclared(schema, p.personalization),
  });
  const [baseline, setBaseline] = useState<Baseline>(() => snapshot(pass));
  const [draft, setDraft] = useState<FormValues>(baseline.values);
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState(false);
  const formId = useId();
  const [serverErrors, setServerErrors] = useState<Record<string, string>>();

  // Void state is pass.status; a /voided input would contradict the header.
  const hiddenKeys = useMemo(() => keysBoundTo(manifest, '/voided'), [manifest]);

  const dirty = !sameValues(draft, baseline.values);
  const stale = pass.version !== baseline.version;
  const conflict = dirty && (rejected || stale);
  const guard = useUnsavedChangesGuard(dirty && !readOnly);

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
  const check = useFormErrors(errors);

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
    if (locked) return;
    const principalId = currentPrincipal();
    if (!principalId || !canMutatePass(qc, pass, principalId)) return;
    setSaving(true);
    setServerErrors(undefined);
    try {
      const next = await send({
        input: changedKeys(baseline.values, draft),
        ...(notify ? { notify: true } : {}),
      });
      if (!canMutatePass(qc, pass, principalId)) return;
      qc.setQueryData(passKeys.detail(pass.id), next);
      if (!canMutatePass(qc, pass, principalId)) return;
      take(next, {});
      setNotify(false);
      check.reset();
      void qc.invalidateQueries({ queryKey: passKeys.all });
      if (notify) toast.info('Fields saved; notification requested');
      else toast.success('Fields saved');
    } catch (error) {
      if (!canMutatePass(qc, pass, principalId)) return;
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
      if (currentPrincipal() === principalId) setSaving(false);
    }
  }

  async function reset(key: string) {
    if (locked) return;
    const principalId = currentPrincipal();
    if (!principalId || !canMutatePass(qc, pass, principalId)) return;
    const mine = changedKeys(baseline.values, draft);
    delete mine[key];
    setSaving(true);
    try {
      const next = await send({ resetToConnection: [key] });
      if (!canMutatePass(qc, pass, principalId)) return;
      qc.setQueryData(passKeys.detail(pass.id), next);
      if (!canMutatePass(qc, pass, principalId)) return;
      take(next, mine);
      void qc.invalidateQueries({ queryKey: passKeys.all });
      toast.success('Reset to connection');
    } catch (error) {
      if (!canMutatePass(qc, pass, principalId)) return;
      if (isApiError(error) && error.status === 412) {
        setRejected(true);
        void qc.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      } else toast.error(error, 'Could not reset');
    } finally {
      if (currentPrincipal() === principalId) setSaving(false);
    }
  }

  return (
    <Form
      id={formId}
      {...check.form}
      onValid={() => void save()}
      className="flex flex-col gap-6 pb-16"
    >
      {removed ? (
        <Callout
          tone="warning"
          actions={
            runner ? (
              <Button
                size="sm"
                variant="outline"
                loading={runner.pending.restore}
                disabled={readOnly}
                onClick={() => runner.run('restore')}
              >
                Restore
              </Button>
            ) : null
          }
        >
          Removed from Wallet. Restore to edit.
        </Callout>
      ) : voided ? (
        <Callout tone="info">Unvoid to edit.</Callout>
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
      <BudgetNote budget={pass.pushBudget} show={notify && dirty && !locked} />
      <SchemaForm
        schema={schema}
        value={draft}
        onChange={setDraft}
        disabled={saving || locked}
        hiddenKeys={hiddenKeys}
        showAllErrors={Object.keys(check.errors).length > 0}
        serverErrors={serverErrors}
        fieldSources={pass.connectionId ? pass.fieldSources : undefined}
        sourceName={connection.data?.name}
        onResetField={pass.connectionId ? (k) => void reset(k) : undefined}
      />
      <SaveBar
        dirty={dirty && !readOnly}
        saving={saving}
        extra={
          locked ? null : (
            <CheckboxField
              label="Notify holders"
              checked={notify}
              disabled={!dirty || saving}
              onCheckedChange={(c) => setNotify(c === true)}
            />
          )
        }
        formId={formId}
        onDiscard={() => {
          setDraft(baseline.values);
          setRejected(false);
          check.reset();
          setNotify(false);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Form>
  );
}
