/** The tag scenarios of the visual gallery (`?visual=1&surface=tags&case=`). */
import { useState } from 'react';
import { SCAN_TAG_COPY } from '../../shared/copy/scan-tags.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { ScanAppView } from './app.tsx';
import { AssignCard, toneOf } from './assign/assign-card.tsx';
import { AssignDock } from './assign/assign-dock.tsx';
import type { TagReader } from './assign/tag-reader.ts';
import type { BindResult, TagEnrollment, TagView } from './assign/types.ts';
import { AssignChip } from './enroll/request-chip.tsx';
import { RequestStrip } from './enroll/request-strip.tsx';
import { grant } from './machine/access-fixtures.test-support.ts';
import { type AssignState, TAG_OFFLINE } from './machine/assign-state.ts';
import { fixtureDisplay } from './machine/fixtures.test-support.ts';
import { initialState } from './machine/initial-state.ts';
import { presentOutcome, viewOf } from './machine/present.ts';
import { fresh } from './machine/reduce-assign.ts';
import type { ScanStore } from './machine/store.ts';
import type { ScanOutcome } from './machine/types.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { ResultCard } from './result/result-card.tsx';
import { DoorDock } from './ui/door-dock.tsx';

const NOW = 1_762_000_000_000;
const ENROLL: TagEnrollment = {
  id: '01900000-0000-7000-8000-0000000000bb',
  holderName: 'Maya Okafor',
  passTitle: 'HQ access',
  scope: 'user',
  requestedByName: 'Ana R.',
  expiresAt: Date.now() + 102_000,
};
const PREVIEW: BindResult = {
  status: 'preview',
  hint: '7F3A',
  assurance: 'basic',
  scope: 'pass',
  bindingId: null,
  card: {
    passId: '01900000-0000-7000-8000-0000000000aa',
    title: 'HQ access',
    subtitle: null,
    templateName: 'Staff · HQ access',
    holderName: 'Maya Okafor',
    photoUrl: null,
  },
  ownerAccount: true,
  skipped: [],
  warnings: [],
  lostAt: null,
  undoUntil: null,
};
const READ = {
  read: { uid: '04a2b37f3a', tech: 'a' as const, source: 'native' as const },
  sig: 't:x',
};
const base = (over: Partial<AssignState> = {}): AssignState => ({ ...fresh('menu', NOW), ...over });

const ANDROID: TagReader = { kind: 'continuous', needsStart: false };
const IPHONE: TagReader = { kind: 'sheet', needsStart: false };
const WEB: TagReader = { kind: 'webnfc', needsStart: true };
const USB: TagReader = { kind: 'wedge', needsStart: false };

interface Assign {
  a: AssignState;
  reader: TagReader;
  knownName?: string | null;
  manager?: boolean;
}
const assigns: Record<string, Assign> = {
  'assign-tag-android': { a: base(), reader: ANDROID },
  'assign-tag-iphone': { a: base(), reader: IPHONE },
  'assign-tag-web': { a: base(), reader: WEB },
  'assign-tag-usb': { a: base(), reader: USB },
  'assign-pass': {
    a: base({
      step: 'pass',
      tag: READ,
      inspected: {
        state: 'new',
        hint: '7F3A',
        assurance: 'basic',
        bound: null,
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
    }),
    reader: ANDROID,
  },
  'assign-pass-banner': {
    a: base({
      step: 'pass',
      banner: 'voided',
      tag: READ,
      inspected: {
        state: 'new',
        hint: '7F3A',
        assurance: 'basic',
        bound: null,
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
    }),
    reader: ANDROID,
  },
  'assign-confirm': {
    a: base({
      step: 'confirm',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      preview: { ...PREVIEW, warnings: [] },
    }),
    reader: ANDROID,
  },
  'assign-confirm-person': {
    a: base({
      step: 'confirm',
      scope: 'user',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      preview: { ...PREVIEW, warnings: ['replaces_pass_tag'] },
    }),
    reader: ANDROID,
  },
  'assign-confirm-other': {
    a: base({
      step: 'confirm',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      inspected: {
        state: 'bound',
        hint: '7F3A',
        assurance: 'basic',
        bound: { scope: 'pass', passTitle: 'Pool day', holderName: 'Leo Park' },
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
      preview: { ...PREVIEW, warnings: ['held_by_other'] },
    }),
    reader: ANDROID,
  },
  'assign-done': {
    a: base({
      step: 'done',
      label: 'Blue fob',
      result: { ...PREVIEW, status: 'bound', bindingId: 'b1', undoUntil: NOW + 600_000 },
    }),
    reader: ANDROID,
  },
  'assign-done-person': {
    a: base({
      step: 'done',
      result: {
        ...PREVIEW,
        status: 'bound',
        scope: 'user',
        bindingId: 'b1',
        undoUntil: NOW + 600_000,
      },
    }),
    reader: ANDROID,
  },
  'assign-lost': {
    a: base({ step: 'error', error: { kind: 'lost', at: NOW - 5 * 86_400_000 } }),
    reader: ANDROID,
  },
  'assign-secure': {
    a: base({ step: 'error', error: { kind: 'secure_needed' } }),
    reader: ANDROID,
  },
  'assign-already': {
    a: base({ step: 'error', error: { kind: 'already_here', at: NOW - 86_400_000, by: 'Sam K.' } }),
    reader: ANDROID,
  },
  'assign-unreadable-web': {
    a: base({ step: 'error', error: { kind: 'unreadable', web: true } }),
    reader: WEB,
  },
  'assign-offline': {
    a: base({ step: 'error', error: { kind: 'not_assigned' } }),
    reader: ANDROID,
  },
  'assign-too-many': {
    a: base({ step: 'error', error: { kind: 'too_many', seconds: 20 } }),
    reader: ANDROID,
  },
  'request-card': {
    a: base({ source: 'request', request: ENROLL, idleAt: ENROLL.expiresAt }),
    reader: ANDROID,
  },
  'request-card-iphone': {
    a: base({ source: 'request', request: { ...ENROLL, scope: 'pass' }, idleAt: ENROLL.expiresAt }),
    reader: IPHONE,
  },
  'request-done': {
    a: base({
      source: 'request',
      step: 'done',
      request: ENROLL,
      result: { ...PREVIEW, status: 'bound', scope: 'user', bindingId: 'b1' },
    }),
    reader: ANDROID,
  },
  'request-waiting': {
    a: base({ source: 'request', request: ENROLL, waiting: true }),
    reader: ANDROID,
  },
};

const tag = (over: Partial<TagView> = {}): TagView => ({
  hint: '7F3A',
  assurance: 'basic',
  scope: 'pass',
  ...over,
});
const manyPasses: TagView['passes'] = [
  { passId: '1', templateName: 'HQ access', state: 'used', reason: null },
  { passId: '2', templateName: 'Gym', state: 'lets_in', reason: null },
  { passId: '3', templateName: 'Parking', state: 'not_here', reason: null },
];
const nonePasses: TagView['passes'] = [
  { passId: '1', templateName: 'HQ access', state: 'refused', reason: 'outside_hours' },
  { passId: '2', templateName: 'Gym', state: 'refused', reason: 'expired' },
  { passId: '3', templateName: 'Parking', state: 'not_here', reason: null },
];
const display = fixtureDisplay('ok');
const doors: Record<
  string,
  { outcome: ScanOutcome; tagRead: boolean; unknown?: boolean; add?: boolean }
> = {
  'door-tag-ok': { outcome: grant({ display, tag: tag() }), tagRead: true },
  'door-tag-of-many': {
    outcome: grant({ display, tag: tag({ scope: 'user', count: 3, passes: manyPasses }) }),
    tagRead: true,
  },
  'door-tag-none': {
    outcome: {
      ...grant({
        display: fixtureDisplay('refused'),
        tag: tag({ scope: 'user', count: 3, passes: nonePasses }),
      }),
      kind: 'refused',
      reason: 'outside_hours',
    } as ScanOutcome,
    tagRead: true,
  },
  'door-unknown': {
    outcome: {
      ...grant(),
      kind: 'refused',
      reason: 'not_found',
      display: null,
      card: null,
      access: null,
      occupancy: null,
    } as ScanOutcome,
    tagRead: true,
    unknown: true,
  },
  'door-add-tag': { outcome: grant({ display, tag: undefined }), tagRead: false, add: true },
  'door-offline': {
    outcome: {
      ...grant(),
      kind: 'system',
      reason: TAG_OFFLINE,
      display: null,
      card: null,
      access: null,
      occupancy: null,
      local: true,
    } as ScanOutcome,
    tagRead: true,
  },
};

export const TAG_SCENARIOS = [
  ...Object.keys(assigns),
  ...Object.keys(doors),
  'door-tap-to-read',
  'request-chip-waiting',
  'request-strip',
] as const;
export type TagScenario = (typeof TAG_SCENARIOS)[number];

const noop = () => undefined;
const handlers = {
  scope: noop,
  label: noop,
  approve: noop,
  closePin: noop,
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

export function TagVisual({ scenario }: { scenario: TagScenario }) {
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
            mood={a?.step === 'done' ? 'happy' : 'flat'}
            pose={a ? (a.step === 'pass' ? 'aim' : 'pair') : 'rest'}
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
              on={handlers}
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
