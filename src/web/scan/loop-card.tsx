import type { ComponentProps, ReactNode } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { Button } from '../ui/button.tsx';
import type { ScanApi } from './api/scan-api.ts';
import type { ScanOutcome } from './machine/types.ts';
import type { useScanMachine } from './machine/use-scan-machine.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import { canAddPhoto } from './result/add-photo.tsx';
import type { PassInspection } from './result/pass-inspector.tsx';
import { ResultCard } from './result/result-card.tsx';
import { BootCard } from './ui/boot-card.tsx';

type Machine = ReturnType<typeof useScanMachine>;

/** What the loop shows in the card slot: the block, a tag card, the verdict, or the pause. */
export function loopCard({
  m,
  session,
  api,
  runtime,
  tagCard,
  result,
  handheld,
  desk,
  approvedBy,
  leave,
  setPass,
}: {
  m: Machine;
  session: ScanSession;
  api: ScanApi;
  runtime: ScanRuntime;
  tagCard: ReactNode;
  result: ScanOutcome | null;
  handheld: boolean;
  desk: ComponentProps<typeof ResultCard>['desk'];
  approvedBy: ComponentProps<typeof ResultCard>['approvedBy'];
  leave: () => void;
  setPass: (pass: PassInspection) => void;
}): ReactNode {
  const { state: s, dispatch, now } = m;
  const l = s.loop;
  if (s.block)
    return (
      <BootCard title="Scanner unavailable" line="Pair this device again." testId="scan-block">
        <Button onClick={leave}>Pair again</Button>
      </BootCard>
    );
  if (tagCard) return tagCard;
  if (result && s.card)
    return (
      <ResultCard
        key={s.card.id}
        outcome={result}
        density={handheld ? 'glance' : 'full'}
        onPass={(card, outcome) => {
          setPass({ outcome, card, live: true, ...('input' in l ? { input: l.input } : {}) });
          dispatch({ type: 'overlay', open: 'settings' });
        }}
        phase={s.card.phase}
        clock={now}
        eventNote={session.event?.note}
        holdMs={l.s === 'verdict' && l.closeAt ? Math.max(0, l.closeAt - l.since) : null}
        onAction={(actionId) => dispatch({ type: 'pick', actionId })}
        onGroup={() => dispatch({ type: 'group' })}
        desk={desk}
        approvedBy={approvedBy}
        addPhoto={canAddPhoto(session) ? api : undefined}
        tagRead={'input' in l && Boolean(l.input.tag)}
      />
    );
  if (l.s === 'paused')
    return (
      <BootCard title="Paused">
        <Button onClick={runtime.resume}>Resume</Button>
      </BootCard>
    );
  return null;
}
