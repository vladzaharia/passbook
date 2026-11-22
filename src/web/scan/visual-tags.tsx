/** The tag scenarios of the visual gallery (`?visual=1&surface=tags&case=`). */
import { useState } from 'react';
import { SCAN_TAG_COPY } from '../../shared/copy/scan-tags.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { ScanAppView } from './app.tsx';
import { AssignCard, toneOf } from './assign/assign-card.tsx';
import { AssignDock } from './assign/assign-dock.tsx';
import { TagProp } from './assign/tag-prop.tsx';
import { AssignChip } from './enroll/request-chip.tsx';
import { RequestStrip } from './enroll/request-strip.tsx';
import { initialState } from './machine/initial-state.ts';
import { moodOf, presentOutcome, viewOf } from './machine/present.ts';
import type { ScanStore } from './machine/store.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { ResultCard } from './result/result-card.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import { assigns, doors, TAG_SCENARIOS, type TagScenario } from './visual-tags-cases.ts';

const noop = () => undefined;
const handlers = {
  scope: noop,
  label: noop,
  approve: noop,
  closePin: noop,
  lookUp: noop,
};
const dockHandlers = {
  cancel: noop,
  back: noop,
  done: noop,
  again: noop,
  bind: noop,
  askManager: noop,
  retry: noop,
  readTag: noop,
  startNfc: noop,
  lookUp: noop,
};
const TINT = {
  ok: 'green',
  heads_up: 'amber',
  refused: 'red',
  system: 'slate',
  ready: 'none',
} as const;

function useStaticStore() {
  const [store] = useState(() => {
    const state = initialState(Date.now());
    state.prefs.holdResults = true;
    const snapshot = { state, view: viewOf(state), now: Date.now() };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      dispatch: () => undefined,
    } as unknown as ScanStore;
  });
  return store;
}

export function TagVisual({
  scenario,
  onLookUp = noop,
}: {
  scenario: TagScenario;
  onLookUp?: () => void;
}) {
  const store = useStaticStore();
  const assign = assigns[scenario];
  const door = doors[scenario];
  const runtime = { camera: { hasTorch: () => false, toggleTorch: async () => false } } as never;
  const a = assign?.a;
  const request = a?.request;
  const chips = a ? (
    <AssignChip
      mode={a.request ? 'request-open' : 'assigning'}
      {...(request ? { holderName: request.holderName, expiresAt: request.expiresAt } : {})}
      onPress={noop}
    />
  ) : scenario === 'request-chip-waiting' ? (
    <AssignChip mode="request-waiting" onPress={noop} />
  ) : null;
  const tint = a
    ? TINT[toneOf(a)]
    : door
      ? presentOutcome(door.outcome, 'door', { holdResults: false }).tint
      : 'none';
  const kindFace = door ? moodOf(door.outcome.kind) : null;
  const face =
    kindFace && kindFace !== 'neutral' ? kindFace : a?.step === 'done' ? 'happy' : 'flat';
  return (
    <ScanStoreContext.Provider value={store}>
      <ScanAppView
        screen={{ s: 'loop' }}
        capsule={{ name: 'Front desk', orgName: 'Northwind HQ', state: 'scanning', chips }}
        camera={<div className="scan-visual-camera" />}
        buddy={
          <Buddy
            scene="scan"
            size="xl-scan"
            mood={face}
            pose={a ? (a.step === 'pass' ? 'aim' : 'pair') : 'rest'}
            {...(a?.tag ? { prop: <TagProp struck={toneOf(a) === 'refused'} /> } : {})}
            {...(a?.step === 'done' ? { beat: 'link' } : {})}
            immediate
          />
        }
        strip={
          a?.step === 'done'
            ? {
                kind: 'ok',
                title: SCAN_TAG_COPY.strip.assigned.split(' · ')[0] ?? '',
                meta: 'Maya Okafor · 6:42 PM',
                undoable: true,
              }
            : { kind: 'ok', title: 'Taylor Chen', meta: '6:42 PM', undoable: false }
        }
        dockRow={
          a && assign ? (
            <AssignDock
              a={a}
              reader={assign.reader}
              manager={assign.manager ?? false}
              webStatus="idle"
              on={dockHandlers}
            />
          ) : (
            <DoorDock
              outcome={door?.outcome ?? null}
              runtime={runtime}
              open={noop}
              onError={noop}
              tags={{
                tapToRead: scenario === 'door-tap-to-read' ? noop : null,
                addTag: door?.add ? noop : null,
                assignUnknown: door?.unknown ? noop : null,
              }}
            />
          )
        }
        tint={tint}
        card={
          a && assign ? (
            <AssignCard
              a={a}
              ctx={{
                org: 'Northwind HQ',
                reader: assign.reader,
                manager: assign.manager ?? false,
                managers: [],
                code: true,
                knownName: assign.knownName ?? null,
                readerNote: null,
                webStatus: 'idle',
              }}
              on={{ ...handlers, lookUp: onLookUp }}
            />
          ) : door ? (
            <ResultCard outcome={door.outcome} phase="up" tagRead={door.tagRead} />
          ) : scenario === 'request-strip' ? (
            <RequestStrip name="Maya Okafor" onOpen={noop} onLater={noop} />
          ) : null
        }
      />
    </ScanStoreContext.Provider>
  );
}

export { TAG_SCENARIOS };
