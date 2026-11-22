import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { reasonHeadline } from '../../../shared/copy/scan-headline.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import type { ScanOutcome } from '../machine/types.ts';

const PassPreview = lazy(() =>
  import('../result/pass-preview.tsx').then((m) => ({ default: m.PassPreview })),
);

/** The pass a lookup picked: who, its state, and the one action that checks it in. */
export function LookupConfirm({
  picked,
  busy,
  onBack,
  onCheckIn,
  orgId,
  timeZone,
}: {
  picked: ScanOutcome;
  busy: boolean;
  onBack: () => void;
  /** Absent in assign mode: the sheet picks a pass for a tag, it never checks one in. */
  onCheckIn?: (card: ScanCard, actionId: string) => void;
  orgId?: string | undefined;
  timeZone?: string | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const card = picked.card;
  const action =
    picked.kind === 'ready'
      ? card?.actions.find((a) => a.kind === 'check_in' && a.available && !a.lock)
      : undefined;
  return (
    <div className="scan-lookup-confirm">
      <Button variant="ghost" iconStart={<ArrowLeft aria-hidden />} onClick={onBack}>
        Back
      </Button>
      {card ? (
        <Suspense fallback={<div className="scan-pass-preview" aria-hidden />}>
          <PassPreview card={card} orgId={orgId} timeZone={timeZone} still />
        </Suspense>
      ) : null}
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {card?.title ?? 'Pass not available'}
      </h2>
      {card ? (
        <>
          <p className="text-sm text-fg-muted">
            {card.template.name}
            {card.subtitle ? ` · ${card.subtitle}` : ''}
          </p>
          <p className="capitalize">{card.status}</p>
        </>
      ) : null}
      {picked.reason && picked.reason !== 'choose' ? (
        <Callout tone={picked.kind === 'refused' ? 'danger' : 'warning'}>
          {reasonHeadline(picked.reason, {
            actionKind: picked.action?.kind,
            action: picked.action?.label,
            place: picked.occupancy?.place.name ?? picked.event?.name,
            flag: picked.flags[0],
            input: picked.value?.label,
          })}
        </Callout>
      ) : null}
      {card && action && onCheckIn ? (
        <Button
          className="scan-lookup-commit"
          disabled={busy}
          onClick={() => onCheckIn(card, action.id)}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
