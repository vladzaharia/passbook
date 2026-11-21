import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { PassDevicesSchema } from '@/shared/contracts/events.ts';
import { type PassDetailDto, PassDetailSchema } from '@/shared/contracts/passes.ts';
import type { ReleaseResult } from '@/shared/contracts/template-release-flow.ts';
import { TemplateReleaseListSchema } from '@/shared/contracts/template-releases.ts';
import { api } from '../../../lib/api.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { passKeys } from '../../passes/api.ts';
import { newKey } from '../../passes/format.ts';
import { useReleaseFlow } from './flow-api.ts';

const TEST = { [MODE_HEADER]: 'test' };
const POLL_MS = 2_000;
const GIVE_UP_MS = 5 * 60_000;

export type TryPhase =
  | { step: 'releasing' }
  | { step: 'making'; result: ReleaseResult }
  | { step: 'waiting'; result: ReleaseResult; pass: PassDetailDto }
  | { step: 'failed'; message: string };

/**
 * Try on my phone, in order: release `version` to Test, make a Test pass from the template's
 * sample for the signed-in admin (no email), then watch the pass's devices every 2 s for 5 min.
 * One idempotency key per pass attempt, so a retry never makes two.
 */
export function useTryFlow(input: {
  templateId: string;
  orgId: string;
  version: string;
  sample: Record<string, unknown>;
  email: string | null;
}) {
  const { templateId, orgId, version, sample, email } = input;
  const flow = useReleaseFlow(templateId, orgId);
  const client = useQueryClient();
  const [phase, setPhase] = useState<TryPhase>({ step: 'releasing' });
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);
  const mounted = useRef(false);
  const key = useRef(newKey());
  const { mutateAsync } = flow;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    void (async () => {
      try {
        setPhase({ step: 'releasing' });
        const result = await mutateAsync({ version, modes: ['test'] });
        if (!mounted.current) return;
        setPhase({ step: 'making', result });
        const list = await api.get(
          `/api/v1/templates/${encodeURIComponent(templateId)}/releases`,
          TemplateReleaseListSchema,
          { headers: TEST, query: { orgId, mode: 'test', provider: 'apple' } },
        );
        const active = list.active;
        if (!active) throw new Error('The version is not in Test yet. Try again.');
        const pass = await api.post(
          '/api/v1/passes',
          PassDetailSchema,
          {
            orgId,
            templateId,
            mode: 'test',
            templateVersion: active.version,
            releaseId: active.id,
            releaseGeneration: active.generation,
            input: sample,
            ...(email ? { holderEmail: email } : {}),
            sendEmail: false,
          },
          { headers: { ...TEST, 'idempotency-key': key.current } },
        );
        await client.invalidateQueries({ queryKey: passKeys.all });
        if (mounted.current) setPhase({ step: 'waiting', result, pass });
      } catch (cause) {
        if (mounted.current) setPhase({ step: 'failed', message: errorMessage(cause) });
      }
    })();
  }, [attempt, client, email, mutateAsync, orgId, sample, templateId, version]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { phase, retry };
}

/** True once a device has registered the pass; polls until then, then stops after five minutes. */
export function useOnPhone(passId: string | undefined) {
  const since = useRef(Date.now());
  const devices = useQuery({
    queryKey: ['admin', 'passes', 'devices', passId, 'try'],
    enabled: passId !== undefined,
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${passId}/devices`, PassDevicesSchema, { headers: TEST, signal }),
    refetchInterval: (q) =>
      q.state.data?.devices.some((d) => d.registeredAt !== null && d.unregisteredAt === null) ||
      Date.now() - since.current > GIVE_UP_MS
        ? false
        : POLL_MS,
  });
  const on =
    devices.data?.devices.some((d) => d.registeredAt !== null && d.unregisteredAt === null) ??
    false;
  return { on, gaveUp: !on && Date.now() - since.current > GIVE_UP_MS };
}
