/** The handheld door's states of the visual gallery (`?visual=1&surface=door&case=`): ready, direction, bundle, queue. */
import { useState } from 'react';
import { ScanSummarySchema } from '../../shared/contracts/scan-session.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import type { ScanApi } from './api/scan-api.ts';
import type { ShownDirection } from './machine/direction-view.ts';
import {
  FIXTURE_NOW,
  fixtureCard,
  fixtureDisplay,
  fixtureOutcome,
} from './machine/fixtures.test-support.ts';
import { localOutcome } from './machine/outcome.ts';
import type { ScanOutcome, ScanState } from './machine/types.ts';
import { ScanPreviewScreen } from './preview-screen.tsx';
import { CameraLayer } from './ui/camera-layer.tsx';
import { MenuTrigger } from './ui/capsule.tsx';
import { CountChip, SyncChip } from './ui/chips.tsx';
import { ShiftSheet } from './ui/shift-sheet.tsx';
import { dockStrip } from './ui/strip-of.ts';
import { lookFromUrl, recentRows, TINT } from './visual-handheld.ts';

export const DOOR_CASES = [
  'ready',
  'ready-in',
  'ready-out',
  'ready-fixed-out',
  'bundle',
  'bundle-heads',
  'bundle-done',
  'bundle-partial',
  'queue',
  'queue-sheet',
  'shift',
  'shift-end',
] as const;
export type DoorCase = (typeof DOOR_CASES)[number];

const NOW = FIXTURE_NOW;
const bundle = {
  id: 'b1',
  name: 'Family pack',
  size: 4,
  checkedIn: 1,
  members: [
    { initials: 'AP', checkedIn: true },
    { initials: 'BP', checkedIn: false },
    { initials: 'CP', checkedIn: false },
    { initials: 'DP', checkedIn: false },
  ],
};
const family = () => {
  const d = fixtureDisplay('ok');
  return {
    card: fixtureCard(),
    action: { id: 'check_in', label: 'Checked in', kind: 'check_in' as const },
    display: {
      ...d,
      panels: [],
      identity: { holder: 'Anna Park', initials: 'AP', photo: null },
      header: { ...d.header, title: null, meta: 'Family pack · Adult', chips: [] },
    },
  };
};
const member = (
  name: string,
  state: 'done' | 'already' | 'refused',
  reason: string | null = null,
) => ({
  name,
  state,
  reason: reason as never,
});

function outcomeOf(c: DoorCase): ScanOutcome | null {
  switch (c) {
    case 'bundle':
      return fixtureOutcome('ok', null, { ...family(), bundle });
    case 'bundle-heads':
      return fixtureOutcome('heads_up', 'already_done', {
        ...family(),
        bundle,
        action: { id: 'check_in', label: 'Let in again', kind: 'check_in' },
        previous: {
          scanId: '01900000-0000-7000-8000-000000000001',
          at: NOW - 12 * 60_000,
          scannerName: 'Side door',
          staffName: null,
          actionLabel: 'Checked in',
          override: false,
        },
      });
    case 'bundle-done':
      return fixtureOutcome('ok', null, {
        ...family(),
        group: {
          total: 4,
          done: 3,
          already: 1,
          refused: 0,
          members: [
            member('Anna Park', 'already', 'already_done'),
            member('Ben Park', 'done'),
            member('Cara Park', 'done'),
            member('Dan Park', 'done'),
          ],
        },
      });
    case 'bundle-partial':
      return fixtureOutcome('ok', null, {
        ...family(),
        group: {
          total: 4,
          done: 1,
          already: 2,
          refused: 1,
          members: [
            member('Anna Park', 'already', 'already_done'),
            member('Ben Park', 'already', 'already_done'),
            member('Cara Park', 'done'),
            member('Dan Park', 'refused', 'voided'),
          ],
        },
      });
    case 'queue':
      return localOutcome('queued', 'saved_offline', null, {
        at: NOW,
        action: { id: 'check_in', label: 'Checked in', kind: 'check_in' },
      });
    default:
      return null;
  }
}

const DIRECTION: Partial<Record<DoorCase, { value: ShownDirection; onCycle?: () => void }>> = {
  ready: { value: 'auto', onCycle: () => undefined },
  'ready-in': { value: 'in', onCycle: () => undefined },
  'ready-out': { value: 'out', onCycle: () => undefined },
  'ready-fixed-out': { value: 'out' },
  bundle: { value: 'in', onCycle: () => undefined },
  'bundle-heads': { value: 'in', onCycle: () => undefined },
  queue: { value: 'in', onCycle: () => undefined },
  'queue-sheet': { value: 'in', onCycle: () => undefined },
  shift: { value: 'in', onCycle: () => undefined },
  'shift-end': { value: 'in', onCycle: () => undefined },
};

const OFFLINE: ScanState['offline'] = { mode: 'list', listAt: NOW - 6 * 60_000, syncing: false };
const QUEUE = { pending: 3, oldestAt: NOW - 90_000, conflicts: 0 };

const summary = ScanSummarySchema.parse({
  from: 0,
  to: 1,
  total: 128,
  ok: 116,
  headsUp: 3,
  refused: 9,
  undone: 3,
  byAction: [{ actionId: 'in', label: 'Check in', count: 116, amount: 0 }],
  firstAt: 1,
  lastAt: 2,
  timeZone: null,
  byHour: [],
  byValue: [],
  byReason: [],
  overrides: { count: 0, latest: [] },
});

function ShiftView({ scenario }: { scenario: DoorCase }) {
  const queued = scenario === 'queue-sheet';
  const [api] = useState(() => ({ summary: async () => summary }) as unknown as ScanApi);
  const rows = async () => [
    {
      key: 'a',
      at: NOW - 3 * 60_000,
      method: 'camera' as const,
      door: 'listed' as const,
      tail: 'AB12',
    },
    {
      key: 'b',
      at: NOW - 2 * 60_000,
      method: 'manual' as const,
      door: 'unverified' as const,
      tail: 'CD34',
    },
    {
      key: 'c',
      at: NOW - 60_000,
      method: 'camera' as const,
      door: 'listed' as const,
      tail: 'EF56',
    },
  ];
  return (
    <ShiftSheet
      open
      ending={scenario === 'shift-end'}
      {...(queued ? { focus: 'queue' as const } : {})}
      api={api}
      since={NOW - 3_600_000}
      pending={3}
      counts={{
        today: 312,
        event: { arrived: 312, inside: null, expected: 500, capacity: 500 },
        asOf: NOW,
        configRev: 1,
      }}
      onClose={() => undefined}
      onEnd={() => undefined}
      {...(queued
        ? { offline: { state: OFFLINE, queue: QUEUE, onSync: () => undefined, rows } }
        : {})}
    />
  );
}

export function DoorVisual({ scenario }: { scenario: DoorCase }) {
  const handheld = useMediaQuery(PHONE);
  const outcome = outcomeOf(scenario);
  const offline = scenario === 'queue' || scenario === 'queue-sheet';
  // A tablet keeps the capsule chip; the word, the button and the dashed marks are the handheld's.
  const direction = handheld ? DIRECTION[scenario] : undefined;
  const strip = offline
    ? dockStrip(
        { online: false, offline: OFFLINE, queue: QUEUE, unsure: [] },
        undefined,
        false,
        NOW,
        handheld ? { since: NOW - 4 * 60_000 } : undefined,
      )
    : outcome
      ? { kind: 'ok' as const, title: 'Anna Park', meta: 'Checked in · 7:44 PM', undoable: true }
      : null;
  return (
    <ScanPreviewScreen
      outcome={outcome}
      camera={
        <CameraLayer
          videoRef={{ current: null }}
          status="live"
          checking={false}
          result={outcome !== null}
          reader={false}
          out={direction?.value === 'out'}
        />
      }
      {...(direction ? { direction } : {})}
      density={handheld ? 'glance' : 'full'}
      capsuleState={offline ? 'offline' : 'scanning'}
      chips={
        <>
          {offline ? <SyncChip state={{ kind: 'offline', queued: 3 }} /> : null}
          <CountChip count={312} capacity={500} />
        </>
      }
      menu={<MenuTrigger />}
      strip={strip}
      recent={recentRows(false)}
      clock={NOW}
      look={lookFromUrl()}
      tint={outcome ? (TINT[outcome.kind === 'queued' ? 'ok' : outcome.kind] ?? 'none') : 'none'}
    >
      {scenario === 'queue-sheet' || scenario.startsWith('shift') ? (
        <ShiftView scenario={scenario} />
      ) : null}
    </ScanPreviewScreen>
  );
}
