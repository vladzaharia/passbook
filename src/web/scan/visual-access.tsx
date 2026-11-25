/** The access and occupancy scenarios of the visual gallery (`?visual=1&surface=access&case=`). */
import { useEffect, useState } from 'react';
import { DEFAULT_TIME_ZONE } from '../../shared/time-zone.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { ScanAppView } from './app.tsx';
import { fakeInsideApi, insideRow } from './inside/inside-fake.test-support.ts';
import { InsideSheet } from './inside/inside-sheet.tsx';
import { useInside } from './inside/use-inside.ts';
import type { ResolvedOutcome } from './machine/access-events.ts';
import { exit, full, grant, heldIn, heldOut } from './machine/access-fixtures.test-support.ts';
import { FIXTURE_NOW, fixtureOutcome } from './machine/fixture-data.test-support.ts';
import { fixtureDisplay } from './machine/fixtures.test-support.ts';
import { moodOf, presentOutcome } from './machine/present.ts';
import type { ScanOutcome } from './machine/types.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { ResultCard } from './result/result-card.tsx';
import {
  fakeRollCall,
  T0 as ROLL_T0,
  call as rollCall,
  person as rollPerson,
} from './roll-call/roll-call-fake.test-support.ts';
import { RollCallPanel } from './roll-call/roll-call-panel.tsx';
import { StartRollCallFooter } from './roll-call/start-footer.tsx';
import { useRollCall } from './roll-call/use-roll-call.ts';
import { PlaceChip } from './ui/chips.tsx';
import { DirectionChip } from './ui/direction-chip.tsx';
import { DirectionSheet } from './ui/direction-sheet.tsx';
import { DoorThumbRow } from './ui/dock.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import { useStaticStore } from './visual-tags.tsx';

const display = fixtureDisplay('ok');
const verdicts: Record<string, ScanOutcome> = {
  grant: grant({ display }),
  exit: exit({ display }),
  'held-in': heldIn({ display: fixtureDisplay('heads_up') }),
  'held-out': heldOut({ display: fixtureDisplay('heads_up') }),
  full: full({ display: fixtureDisplay('heads_up') }),
  'admit-day': fixtureOutcome('ok', null, {
    display,
    at: FIXTURE_NOW,
    admit: {
      type: 'Day pass',
      rule: { kind: 'until', at: FIXTURE_NOW + 6 * 3_600_000 },
      timeZone: DEFAULT_TIME_ZONE,
    },
  }),
  'admit-guest': {
    ...grant({ display }),
    admit: { type: 'Guest', rule: { kind: 'visit', n: 2, of: 3 }, timeZone: DEFAULT_TIME_ZONE },
  },
  'admit-ended': fixtureOutcome('refused', 'ended', {
    display: fixtureDisplay('refused'),
    at: FIXTURE_NOW,
    admit: { type: 'Day pass', rule: null, timeZone: DEFAULT_TIME_ZONE },
  }),
  'refused-exit': fixtureOutcome('refused', 'voided', {
    at: FIXTURE_NOW,
    exitAllowed: true,
    card: null,
    display: null,
  }),
  resolved: { ...grant({ display }), resolvedBy: 'Sam K.' } as ResolvedOutcome,
};

function faceOf(kind: ScanOutcome['kind']) {
  const mood = moodOf(kind);
  return mood === 'neutral' ? 'flat' : mood;
}

export const ACCESS_SCENARIOS = [
  ...Object.keys(verdicts),
  'direction',
  'inside',
  'inside-empty',
  'inside-offline',
  'roll-call',
  'roll-call-done',
  'roll-call-offline',
  'roll-call-stalled',
  'roll-call-start',
] as const;
export type AccessScenario = (typeof ACCESS_SCENARIOS)[number];

const quietSocket = () => ({ close: () => undefined });

function RollScenario({ scenario }: { scenario: AccessScenario }) {
  const done = { status: 'present' as const, by: 'Sam K.', at: ROLL_T0 };
  const people =
    scenario === 'roll-call-done'
      ? [0, 1, 2, 3].map((n) => rollPerson(n, { mark: done }))
      : [
          rollPerson(0, { presence: 'lapsed', notConfirmedOut: true }),
          rollPerson(1, { late: true }),
          rollPerson(2, { mark: done }),
          rollPerson(3, { mark: { status: 'out', by: 'Ana R.', at: ROLL_T0 } }),
          rollPerson(4),
        ];
  const [port] = useState(() => fakeRollCall(rollCall(people)));
  // Offline: the call loaded, then the connection dropped and a tap is waiting to sync.
  const [dropped, setDropped] = useState(false);
  const online = scenario !== 'roll-call-offline' || !dropped;
  const roll = useRollCall({
    port,
    enabled: true,
    online,
    by: '',
    connect: quietSocket,
  });
  const loaded = roll.call !== null;
  const { mark } = roll;
  useEffect(() => {
    if (scenario !== 'roll-call-offline' || !loaded || dropped) return;
    setDropped(true);
    mark(rollPerson(4).passId, 'present');
  }, [scenario, loaded, dropped, mark]);
  const inside = useInside({
    api: fakeInsideApi([]),
    active: false,
    online,
    notify: { undo: () => undefined, error: () => undefined, info: () => undefined },
  });
  // Stalled: the server kept failing, so two taps wait and the desk is told, with Try again.
  const shown =
    scenario === 'roll-call-stalled'
      ? { ...roll, stalled: true, pending: 2, retryStalled: () => undefined }
      : roll;
  return (
    <InsideSheet
      open
      onClose={() => undefined}
      inside={inside}
      online={online}
      onOpenRow={() => undefined}
      body={
        <RollCallPanel
          roll={shown}
          online={online}
          now={ROLL_T0 + 12 * 60_000}
          onEnd={() => undefined}
          onPrint={() => undefined}
        />
      }
    />
  );
}

function InsideScenario({ scenario }: { scenario: AccessScenario }) {
  const [api] = useState(() =>
    fakeInsideApi(
      scenario === 'inside-empty'
        ? []
        : [
            insideRow(0, { flags: ['long_stay'] }),
            insideRow(1, { host: 'Ana R.' }),
            insideRow(2),
            insideRow(3),
          ],
    ),
  );
  const online = scenario !== 'inside-offline';
  const inside = useInside({
    api,
    active: true,
    online,
    notify: { undo: () => undefined, error: () => undefined, info: () => undefined },
  });
  return (
    <InsideSheet
      open
      onClose={() => undefined}
      inside={inside}
      online={online}
      onOpenRow={() => undefined}
      footer={
        scenario === 'roll-call-start' ? (
          <StartRollCallFooter disabled={false} onStart={() => undefined} />
        ) : undefined
      }
    />
  );
}

const noop = () => undefined;
const runtime = { camera: { hasTorch: () => false, toggleTorch: async () => false } } as never;

export function AccessVisual({ scenario }: { scenario: AccessScenario }) {
  const outcome = verdicts[scenario];
  const store = useStaticStore();
  // A sheet over the loop: the loop names the page, so the gallery names it here.
  if (scenario === 'roll-call-start' || scenario.startsWith('inside'))
    return (
      <>
        <h1 className="sr-only">Front desk</h1>
        <InsideScenario scenario={scenario} />
      </>
    );
  if (scenario.startsWith('roll-call'))
    return (
      <>
        <h1 className="sr-only">Front desk</h1>
        <RollScenario scenario={scenario} />
      </>
    );
  return (
    <>
      <ScanAppView
        screen={{ s: 'loop' }}
        capsule={{
          name: 'Front desk',
          state: 'scanning',
          chips: (
            <>
              <DirectionChip
                setting="both"
                pin={scenario === 'direction' ? 'out' : null}
                onOpen={() => undefined}
              />
              <PlaceChip name="Gym" inNow={42} capacity={60} />
            </>
          ),
        }}
        camera={<div className="scan-visual-camera" />}
        buddy={<Buddy scene="scan" size="xl-scan" mood={faceOf(outcome?.kind ?? 'ok')} immediate />}
        strip={{ kind: 'ok', title: 'Maya Okafor', meta: 'In · Gym · 6:41 PM', undoable: true }}
        dockRow={
          scenario === 'refused-exit' ? (
            <ScanStoreContext.Provider value={store}>
              <DoorDock outcome={outcome ?? null} runtime={runtime} open={noop} onError={noop} />
            </ScanStoreContext.Provider>
          ) : (
            <DoorThumbRow
              onLookUp={() => undefined}
              inside={{ count: 42, onOpen: () => undefined }}
            />
          )
        }
        tint={outcome ? presentOutcome(outcome, 'door', { holdResults: false }).tint : 'none'}
        card={outcome ? <ResultCard outcome={outcome} phase="up" /> : null}
      />
      {scenario === 'direction' ? (
        <DirectionSheet open pin="out" onPick={() => undefined} onClose={() => undefined} />
      ) : null}
    </>
  );
}
