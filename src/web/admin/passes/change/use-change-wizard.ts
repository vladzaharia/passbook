import { useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useDebounced } from '../../../lib/debounce.ts';
import { orgPath } from '../../../lib/scope.ts';
import { localZone } from '../../../lib/timezones.ts';
import type { DateTimeValue } from '../../../ui/index.ts';
import { commonFields } from '../../messages/common-fields.ts';
import { templateDetailQuery } from '../../templates/api.ts';
import { fingerprint, newKey } from '../format.ts';
import { localToIso } from '../schema-form/datetime.ts';
import { type ChangeBody, useChangeActions, useChangePreview } from './api.ts';
import { type ChangeKind, type FieldRow, patchOf } from './model.ts';
import { isDrift, refusalText } from './refusal.ts';
import { type ChangeSelection, targetOf, templatesOf } from './selection.ts';
import { SETTABLE } from './value-control.tsx';

export type Start = 'now' | 'later';

/** The wizard's state, its server preview and the run it starts. */
export function useChangeWizard(orgId: string, selection: ChangeSelection, initial: ChangeKind) {
  const navigate = useNavigate();
  const templateIds = templatesOf(selection);
  const details = useQueries({
    queries: templateIds.map((id) => templateDetailQuery(id, orgId)),
  });
  const loaded = details.flatMap((d) => (d.data ? [d.data] : []));
  const fields = useMemo(
    () => commonFields(loaded).filter((f) => SETTABLE.has(f.widget)),
    [loaded],
  );
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ChangeKind>(initial);
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [notify, setNotify] = useState(false);
  const [message, setMessage] = useState('');
  const [start, setStart] = useState<Start>('now');
  const [at, setAt] = useState<DateTimeValue>({ local: '', zone: localZone() });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [drift, setDrift] = useState<number | null>(null);
  const key = useRef<{ fp: string; key: string }>({ fp: '', key: newKey() });
  const actions = useChangeActions();

  const patch = patchOf(kind, rows);
  const tellable = kind !== 'void';
  const text = notify && kind === 'fields' ? message.trim() : '';
  const body: ChangeBody | undefined = patch
    ? {
        orgId,
        target: targetOf(selection),
        patch,
        notify: tellable && notify,
        ...(text ? { message: text } : {}),
      }
    : undefined;
  const settled = useDebounced(body, 400);
  const preview = useChangePreview(settled);
  const atMs =
    start === 'later' && at.local ? Date.parse(localToIso(at.local, at.zone) ?? '') : NaN;
  const whenOk = start === 'now' || Number.isFinite(atMs);

  async function submit(expectCount: number) {
    if (!body) return;
    const fp = fingerprint([body, expectCount, start === 'later' ? atMs : null]);
    if (key.current.fp !== fp) key.current = { fp, key: newKey() };
    setRefusal(null);
    try {
      const run = await actions.create.mutateAsync({
        body: { ...body, expectCount },
        key: key.current.key,
        at: start === 'later' ? atMs : undefined,
      });
      void navigate({ href: orgPath(orgId, `/passes/change/${run.id}`) });
    } catch (error) {
      if (isDrift(error)) {
        const again = await preview.refetch();
        setDrift(again.data?.targeted ?? 0);
        return;
      }
      setRefusal(refusalText(error));
    }
  }

  return {
    details,
    fields,
    step,
    setStep,
    kind,
    setKind,
    rows,
    setRows,
    notify,
    setNotify,
    message,
    setMessage,
    start,
    setStart,
    at,
    setAt,
    patch,
    tellable,
    preview,
    whenOk,
    refusal,
    setRefusal,
    drift,
    setDrift,
    submit,
    submitting: actions.create.isPending,
  };
}
export type ChangeWizard = ReturnType<typeof useChangeWizard>;
