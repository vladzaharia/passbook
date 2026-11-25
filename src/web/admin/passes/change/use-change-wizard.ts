import { useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { useSeededZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { useDebounced } from '../../../lib/debounce.ts';
import type { ApiError } from '../../../lib/errors.ts';
import { orgPath } from '../../../lib/scope.ts';
import type { DateTimeValue } from '../../../ui/index.ts';
import { commonFields } from '../../messages/common-fields.ts';
import { templateDetailQuery } from '../../templates/api.ts';
import { fingerprint, newKey } from '../format.ts';
import { localToIso } from '../schema-form/datetime.ts';
import { type ChangeBody, useChangeActions, useChangePreview } from './api.ts';
import { type ChangeKind, type FieldRow, patchOf } from './model.ts';
import { isDrift, isRateLimited, refusalText } from './refusal.ts';
import { type ChangeSelection, clearSelection, targetOf, templatesOf } from './selection.ts';
import { SETTABLE } from './value-control.tsx';

export type Start = 'now' | 'later';

/** The wizard's state, its server preview and the run it starts. */
export function useChangeWizard(
  orgId: string,
  selection: ChangeSelection,
  initial: ChangeKind,
  tell = false,
) {
  const navigate = useNavigate();
  const templateIds = templatesOf(selection);
  const details = useQueries({
    queries: templateIds.map((id) => templateDetailQuery(id, orgId)),
  });
  // A new array every render would recompute the fields and restart the debounce for good.
  const loadedKey = details.map((d) => d.dataUpdatedAt).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on when the details were read
  const fields = useMemo(
    () =>
      commonFields(details.flatMap((d) => (d.data ? [d.data] : []))).filter((f) =>
        SETTABLE.has(f.widget),
      ),
    [loadedKey],
  );
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<ChangeKind>(initial);
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [notify, setNotify] = useState(tell && initial === 'design');
  const [message, setMessage] = useState('');
  const [start, setStart] = useState<Start>('now');
  const [at, setAt] = useState<DateTimeValue>({ local: '', zone: DEFAULT_TIME_ZONE });
  const orgZone = useSeededZone(orgId, (from, to) =>
    setAt((a) => (a.zone === from ? { ...a, zone: to } : a)),
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The create answered 429: the page says so with a Retry, and the selection and step stay. */
  const [limited, setLimited] = useState<ApiError | null>(null);
  const [drift, setDrift] = useState<number | null>(null);
  const key = useRef<{ fp: string; key: string }>({ fp: '', key: newKey() });
  const actions = useChangeActions();

  const patch = patchOf(kind, rows);
  const tellable = kind !== 'void';
  const text = notify && kind === 'fields' ? message.trim() : '';
  const target = targetOf(selection);
  const body: ChangeBody | undefined =
    patch && target
      ? {
          orgId,
          target,
          patch,
          notify: tellable && notify,
          ...(text ? { message: text } : {}),
        }
      : undefined;
  const bodyKey = body ? fingerprint(body) : '';
  const settledKey = useDebounced(bodyKey, 400);
  const settled = useMemo<ChangeBody | undefined>(
    () => (settledKey ? (JSON.parse(settledKey) as ChangeBody) : undefined),
    [settledKey],
  );
  const preview = useChangePreview(settled);
  /** The preview answers the patch on screen, not an earlier one. */
  const fresh = settledKey === bodyKey && !preview.isPlaceholderData && !preview.isFetching;
  const chooseKind = (next: ChangeKind) => {
    setKind(next);
    if (next === 'void') {
      setNotify(false);
      // A void has no holders step: a start time picked there would hide behind it.
      setStart('now');
    }
  };
  const atMs =
    start === 'later' && at.local ? Date.parse(localToIso(at.local, at.zone) ?? '') : NaN;
  const whenOk = start === 'now' || Number.isFinite(atMs);

  async function submit(expectCount: number) {
    if (!body) return;
    const fp = fingerprint([body, expectCount, start === 'later' ? atMs : null]);
    if (key.current.fp !== fp) key.current = { fp, key: newKey() };
    setRefusal(null);
    setLimited(null);
    try {
      const run = await actions.create.mutateAsync({
        body: { ...body, expectCount },
        key: key.current.key,
        at: start === 'later' ? atMs : undefined,
      });
      clearSelection();
      void navigate({ href: orgPath(orgId, `/passes/change/${run.id}`) });
    } catch (error) {
      if (isDrift(error)) {
        const again = await preview.refetch();
        setDrift(again.data?.targeted ?? 0);
        return;
      }
      if (isRateLimited(error)) setLimited(error);
      setRefusal(refusalText(error));
    }
  }

  return {
    timeZone: orgZone,
    details,
    fields,
    step,
    setStep,
    kind,
    chooseKind,
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
    fresh,
    whenOk,
    startMs: Number.isFinite(atMs) ? atMs : null,
    refusal,
    setRefusal,
    limited,
    setLimited,
    drift,
    setDrift,
    submit,
    submitting: actions.create.isPending,
  };
}
export type ChangeWizard = ReturnType<typeof useChangeWizard>;
