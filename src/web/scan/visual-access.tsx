/** The access and occupancy scenarios of the visual gallery (`?visual=1&surface=access&case=`). */
import { useState } from 'react';
import { Buddy } from '../ui/art/buddy.tsx';
import { ScanAppView } from './app.tsx';
import { fakeInsideApi, insideRow, rows } from './inside/inside-fake.test-support.ts';
import { InsideSheet } from './inside/inside-sheet.tsx';
import { useInside } from './inside/use-inside.ts';
import type { ResolvedOutcome } from './machine/access-events.ts';
import { exit, full, grant, heldIn, heldOut } from './machine/access-fixtures.test-support.ts';
import { fixtureDisplay } from './machine/fixtures.test-support.ts';
import { presentOutcome } from './machine/present.ts';
import type { ScanOutcome } from './machine/types.ts';
import { ResultCard } from './result/result-card.tsx';
import { PlaceChip } from './ui/chips.tsx';
import { DirectionChip } from './ui/direction-chip.tsx';
import { DirectionSheet } from './ui/direction-sheet.tsx';
import { DoorThumbRow } from './ui/dock.tsx';

const display = fixtureDisplay('ok');
const verdicts: Record<string, ScanOutcome> = {
  grant: grant({ display }),
  exit: exit({ display }),
  'held-in': heldIn({ display: fixtureDisplay('heads_up') }),
  'held-out': heldOut({ display: fixtureDisplay('heads_up') }),
  full: full({ display: fixtureDisplay('heads_up') }),
  resolved: { ...grant({ display }), resolvedBy: 'Sam K.' } as ResolvedOutcome,
};

export const ACCESS_SCENARIOS = [
  ...Object.keys(verdicts),
  'direction',
  'inside',
  'inside-empty',
  'inside-offline',
] as const;
export type AccessScenario = (typeof ACCESS_SCENARIOS)[number];

function InsideScenario({ scenario }: { scenario: AccessScenario }) {
  const [api] = useState(() =>
    fakeInsideApi(
      scenario === 'inside-empty'
        ? []
        : [
            insideRow(0, { flags: ['long_stay'] }),
            insideRow(1, { host: 'Ana R.' }),
            ...rows(4).slice(2),
          ],
    ),
  );
  const online = scenario !== 'inside-offline';
  const inside = useInside({
    api,
    active: true,
    online,
    notify: { undo: () => undefined, error: () => undefined },
  });
  return (
    <InsideSheet
      open
      onClose={() => undefined}
      inside={inside}
      online={online}
      onOpenRow={() => undefined}
    />
  );
}

export function AccessVisual({ scenario }: { scenario: AccessScenario }) {
  const outcome = verdicts[scenario];
  if (scenario.startsWith('inside')) return <InsideScenario scenario={scenario} />;
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
        buddy={<Buddy scene="scan" size="xl-scan" mood="happy" immediate />}
        strip={{ kind: 'ok', title: 'Maya Okafor', meta: 'In · Gym · 6:41 PM', undoable: true }}
        dockRow={
          <DoorThumbRow
            onLookUp={() => undefined}
            inside={{ count: 42, onOpen: () => undefined }}
          />
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
