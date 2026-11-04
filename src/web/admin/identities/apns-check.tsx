import { BadgeCheck, CircleDashed, OctagonX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ApnsProbeResultSchema, IdentitySchema } from '@/shared/contracts/identities.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { cn } from '@/web/lib/cn.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { Button, StatusPill } from '@/web/ui/index.ts';
import { useCheckApns } from './queries.ts';
import './apns-check.css';

type Result = z.infer<typeof ApnsProbeResultSchema>;
type Identity = z.infer<typeof IdentitySchema>;
const METHOD_LABEL = {
  certificate: 'Certificate binding',
  key: 'Push key',
  none: 'Not set up',
} as const;

type Health = Result['health'] | Identity['apnsHealth'];

const REJECTED = new Set([
  'BadCertificate',
  'BadCertificateEnvironment',
  'Forbidden',
  'ExpiredProviderToken',
  'InvalidProviderToken',
]);
const TOPIC = new Set(['TopicDisallowed', 'MissingTopic']);
const UNREACHABLE = new Set(['NetworkError', 'Timeout', 'ServiceUnavailable']);

/** One sentence for a failed or unclear check; the code stays beside it in mono. */
export function failureSentence(
  reason: string | null,
  status?: number,
  method?: Identity['pushMethod'],
): string {
  if (reason === 'PushUnavailable')
    return 'Push is not set up. Add a push key or a certificate binding.';
  if (reason && TOPIC.has(reason))
    return 'Apple refused this pass type for the certificate. Check the pass type ID.';
  if ((reason && REJECTED.has(reason)) || status === 403)
    return method === 'key'
      ? 'Apple rejected the push key. Check the key ID and team, or upload a new key.'
      : 'Apple rejected the push certificate. Upload a new one.';
  if (status === 0 || (reason && UNREACHABLE.has(reason)))
    return method === 'key'
      ? 'Could not reach Apple with the push key. Check the Worker logs for APNS_TOKEN_TRANSPORT_FAILED.'
      : 'Could not reach Apple. Try again.';
  return 'Apple gave no clear answer. Try again later.';
}

function HealthPill({ health, available }: { health: Health; available: boolean }) {
  if (!available || health === 'unavailable')
    return <StatusPill status="not_configured">Not set up</StatusPill>;
  if (health === 'healthy') return <StatusPill status="verified">Healthy</StatusPill>;
  if (health === 'failing') return <StatusPill status="failing">Failing</StatusPill>;
  if (health === 'inconclusive') return <StatusPill status="degraded">Unclear</StatusPill>;
  return <StatusPill status="not_checked" />;
}

/**
 * The APNs row of the Certificate card: seal, status pill, last check and an inline Check. Rings
 * leave the seal while the check runs; the answer pops (healthy) or shakes (failing) it once.
 */
export function ApnsRow({ identity }: { identity: Identity }) {
  const check = useCheckApns(identity.id);
  const [result, setResult] = useState<Result>();
  const [answer, setAnswer] = useState<{ n: number; ok: boolean }>();
  const [ringing, setRinging] = useState(false);
  const seal = useRef<HTMLSpanElement>(null);
  const health: Health = result?.health ?? identity.apnsHealth;
  const reason = result ? result.reason : identity.apnsReason;
  const checkedAt = result?.checkedAt ?? identity.apnsCheckedAt;
  const bad = health === 'failing' || health === 'inconclusive';
  const Seal = health === 'healthy' ? BadgeCheck : bad ? OctagonX : CircleDashed;

  // Replays the one-shot answer on every check.
  useEffect(() => {
    const el = seal.current;
    if (!answer || !el) return;
    el.removeAttribute('data-result');
    void el.offsetWidth;
    el.setAttribute('data-result', answer.ok ? 'healthy' : 'failing');
  }, [answer]);

  async function run() {
    let ok = false;
    setRinging(true);
    // The rings make at least one full pass, so a fast answer still reads as a check.
    const minimum = new Promise((r) => setTimeout(r, 640));
    try {
      const [next] = await Promise.all([check.mutateAsync(), minimum]);
      setResult(next);
      ok = next.health === 'healthy';
    } catch {
      // check.error renders under the row; the seal shakes like any failed check.
      await minimum;
      setResult(undefined);
    }
    setRinging(false);
    setAnswer((a) => ({ n: (a?.n ?? 0) + 1, ok }));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          ref={seal}
          aria-hidden
          data-pending={ringing || undefined}
          className={cn(
            'wl-apns-seal inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-sunken',
            health === 'healthy' ? 'text-success' : bad ? 'text-danger' : 'text-fg-muted',
          )}
        >
          <span className="wl-apns-ring" />
          <span className="wl-apns-ring" />
          <Seal className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-fg-strong">APNs</span>
          <span className="text-xs text-fg-muted">
            {METHOD_LABEL[result?.method ?? identity.pushMethod]}
          </span>
          <HealthPill health={health} available={identity.apnsAvailable} />
          {checkedAt ? (
            <span className="text-xs text-fg-muted">Checked {formatDateTime(checkedAt)}</span>
          ) : null}
        </div>
        {identity.apnsAvailable ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={ringing}
            aria-busy={ringing || undefined}
            iconStart={<ACTION_ICON.recheck aria-hidden />}
            onClick={() => void run()}
          >
            {ringing ? 'Checking' : 'Check'}
          </Button>
        ) : null}
      </div>
      <div role="status" className="text-sm">
        {check.isError ? (
          <p className="text-fg">{errorMessage(check.error)}</p>
        ) : bad ? (
          <p className="text-fg">
            {failureSentence(reason, result?.status, result?.method ?? identity.pushMethod)}
            {reason ? <span className="ml-2 font-mono text-xs text-fg-muted">{reason}</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
