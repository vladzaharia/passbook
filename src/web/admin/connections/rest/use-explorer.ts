import { useRef, useState } from 'react';
import type { z } from 'zod';
import type { ProbeDetectionsSchema } from '@/shared/contracts/connection-probe.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import {
  hostOf,
  type ProbeFailure,
  type ProbeResult,
  probeFailure,
  requestFailure,
  useRestProbe,
} from './probe-api.ts';
import { DEFAULT_ID, DEFAULT_RECORDS, KEY, readPagination } from './rest-values.ts';

type Detections = z.infer<typeof ProbeDetectionsSchema>;

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** What a first sample fills in: only settings still at their default, so nothing the user chose is lost. */
export function preselect(v: FormValues, det: Detections): FormValues {
  const patch: FormValues = {};
  const records = det.records[0];
  if (records && (blank(v[KEY.records]) || v[KEY.records] === DEFAULT_RECORDS))
    patch[KEY.records] = records.pointer;
  const id = det.id[0];
  if (id && (blank(v[KEY.id]) || v[KEY.id] === DEFAULT_ID)) patch[KEY.id] = id.pointer;
  const page = det.pagination[0];
  if (page && page.confidence !== 'low' && readPagination(v).style === 'none')
    patch[KEY.pagination] = page.config;
  return patch;
}

/** What a page-2 check depends on: a change to any of these needs a fresh first page. */
const keyOf = (v: FormValues) =>
  JSON.stringify([
    v.baseUrl,
    v[KEY.path],
    v[KEY.records],
    v[KEY.id],
    v[KEY.pagination],
    v['list.query'],
  ]);

export interface ExplorerArgs {
  orgId: string;
  connectionId?: string | undefined;
  value: FormValues;
  onChange: (patch: FormValues) => void;
  toConfig: (v: FormValues) => Record<string, unknown>;
  secrets?: Record<string, string> | undefined;
}

export function useExplorer(a: ExplorerArgs) {
  const probe = useRestProbe({ orgId: a.orgId, connectionId: a.connectionId });
  const [first, setFirst] = useState<ProbeResult>();
  const [second, setSecond] = useState<ProbeResult>();
  const [failure, setFailure] = useState<ProbeFailure>();
  const [probed, setProbed] = useState<string>();
  const [firstTime, setFirstTime] = useState(true);
  const latest = useRef(a);
  latest.current = a;
  const host = hostOf(a.value.baseUrl);

  const take = (res: ProbeResult, page: 1 | 2) => {
    const fail = probeFailure(res, host);
    setFailure(fail ?? undefined);
    if (page === 2) setSecond(res);
    else {
      setFirst(res.body === undefined ? undefined : res);
      setSecond(undefined);
    }
  };

  async function run(v: FormValues, auto: boolean): Promise<void> {
    const cur = latest.current;
    try {
      const res = await probe.mutateAsync({ config: cur.toConfig(v), secrets: cur.secrets });
      take(res, 1);
      setProbed(keyOf(v));
      if (auto && res.ok && res.detections) {
        const patch = preselect(v, res.detections);
        if (Object.keys(patch).length > 0) {
          cur.onChange(patch);
          await run({ ...v, ...patch }, false);
        }
      }
    } catch (error) {
      setFirst(undefined);
      setSecond(undefined);
      setFailure(requestFailure(error));
    }
  }

  const fetchFirst = async () => {
    const auto = firstTime;
    setFirstTime(false);
    await run(latest.current.value, auto);
  };

  async function fetchNext() {
    const next = first?.page?.next;
    if (!next) return;
    const cur = latest.current;
    try {
      take(
        await probe.mutateAsync({ config: cur.toConfig(cur.value), secrets: cur.secrets, next }),
        2,
      );
    } catch (error) {
      setFailure(requestFailure(error));
    }
  }

  return {
    first,
    second,
    failure,
    pending: probe.isPending,
    stale: first !== undefined && probed !== keyOf(a.value),
    fetchFirst,
    fetchNext,
  };
}
