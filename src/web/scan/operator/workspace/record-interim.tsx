import { Eye } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ScanOutcome } from '../../../../shared/contracts/scan.ts';
import { reasonHeadline } from '../../../../shared/copy/scan-headline.ts';
import { Button } from '../../../ui/button.tsx';
import { Callout } from '../../../ui/callout.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { scanId } from '../../platform/id.ts';
import type { Command } from '../keys.ts';
import { PersonAvatar } from '../lists/person-avatar.tsx';
import type { RecordRef } from '../operator-model.ts';
import { Kbd } from './command-field.tsx';

const PassPreview = lazy(() =>
  import('../../result/pass-preview.tsx').then((m) => ({ default: m.PassPreview })),
);

/** Settles a pass for the record: a preview that changes nothing until Check in. */
function useResolvedPass(api: ScanApi, passId: string, delayMs: number) {
  const [state, setState] = useState<{ outcome: ScanOutcome | null; failed: boolean }>({
    outcome: null,
    failed: false,
  });
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({
      outcome: s.outcome?.card?.passId === passId ? s.outcome : null,
      failed: false,
    }));
    const timer = setTimeout(() => {
      api
        .resolve(
          { idempotencyKey: scanId(), input: { passId, method: 'manual' }, clientTs: Date.now() },
          { signal: ac.signal },
        )
        .then(
          (outcome) => !ac.signal.aborted && setState({ outcome, failed: false }),
          () => !ac.signal.aborted && setState({ outcome: null, failed: true }),
        );
    }, delayMs);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [api, passId, delayMs]);
  return state;
}

/**
 * A person opened from a list or a search hit: who they are, where they stand, and Check in.
 * This is the record's shell until the full record (band, actions, history) replaces it; every
 * entry already opens through it, so that swap is one component.
 */
export function RecordInterim({
  api,
  orgId,
  timeZone,
  record,
  onCheckIn,
  keys,
}: {
  api: ScanApi;
  orgId: string | undefined;
  timeZone: string | undefined;
  record: Extract<RecordRef, { kind: 'pass' }>;
  onCheckIn: (card: NonNullable<ScanOutcome['card']>, actionId: string) => void;
  keys: { current: ((command: Command) => boolean) | null };
}) {
  const preview = record.from === 'search';
  const { outcome, failed } = useResolvedPass(api, record.passId, preview ? 140 : 0);
  const card = outcome?.card ?? null;
  const action =
    outcome?.kind === 'ready'
      ? card?.actions.find((a) => a.kind === 'check_in' && a.available && !a.lock)
      : undefined;
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keys.current = (command) => {
      if (command.c !== 'primary' || !primary.current) return false;
      primary.current.click();
      return true;
    };
    return () => {
      keys.current = null;
    };
  }, [keys]);
  const reason = outcome?.reason && outcome.reason !== 'choose' ? outcome.reason : null;
  return (
    <article className="op-record" aria-busy={!outcome && !failed}>
      {preview ? (
        <p className="op-band" data-kind="preview">
          <Eye aria-hidden /> Found by name. Nothing changed yet.
        </p>
      ) : null}
      {failed ? (
        <div className="op-record-body">
          <h2 data-operator-heading tabIndex={-1}>
            Pass not available
          </h2>
          <Callout tone="danger">Could not open this pass. Check your connection.</Callout>
        </div>
      ) : card ? (
        <div className="op-record-body">
          <div className="op-ident">
            <PersonAvatar name={card.title} size="lg" />
            <div className="op-ident-text">
              <h2 className="op-name" data-operator-heading tabIndex={-1}>
                {card.title}
              </h2>
              <p className="op-ident-meta">
                {[card.template.name, card.subtitle].filter(Boolean).join(' · ')}
              </p>
              <p className="op-ident-status">{card.status}</p>
            </div>
          </div>
          <Suspense fallback={<div className="scan-pass-preview" aria-hidden />}>
            <PassPreview card={card} orgId={orgId} timeZone={timeZone} still />
          </Suspense>
          {reason ? (
            <Callout tone={outcome?.kind === 'refused' ? 'danger' : 'warning'}>
              {reasonHeadline(reason, {
                actionKind: outcome?.action?.kind,
                action: outcome?.action?.label,
                place: outcome?.occupancy?.place.name,
                flag: card.flags[0]?.label,
              })}
            </Callout>
          ) : null}
          {action ? (
            <div className="op-actions">
              <Button
                ref={primary}
                onClick={() => onCheckIn(card, action.id)}
                aria-keyshortcuts="Enter"
              >
                {action.label} <Kbd>↵</Kbd>
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="op-record-body" role="status">
          <p className="op-ident-meta">Opening</p>
        </div>
      )}
    </article>
  );
}
