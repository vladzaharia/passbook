/** The offline screens of the visual gallery (`?visual=1&surface=offline&case=`). */
import { useState } from 'react';
import { emptySessionDraft, type SessionDraft } from '../admin/scanning/sessions/draft.ts';
import { SessionOfflineFields } from '../admin/scanning/sessions/session-offline-fields.tsx';
import { localOutcome } from './machine/outcome.ts';
import type { ScanOutcome, ScanState } from './machine/types.ts';
import { ScanPreviewScreen } from './preview-screen.tsx';
import { SyncChip } from './ui/chips.tsx';
import { OfflineStatus } from './ui/offline-status.tsx';
import { dockStrip } from './ui/strip-of.ts';

export const OFFLINE_SCENARIOS = [
  'queued',
  'decide',
  'not-listed',
  'already',
  'voided',
  'no-list',
  'sheet',
  'admin',
] as const;
export type OfflineScenario = (typeof OFFLINE_SCENARIOS)[number];

const NOW = Date.now();
const LIST_AT = NOW - 42 * 60_000;
const CHECK_IN = { id: 'check_in', label: 'Checked in', kind: 'check_in' } as const;

function outcomeOf(scenario: OfflineScenario): ScanOutcome {
  switch (scenario) {
    case 'queued':
      return localOutcome('queued', 'saved_offline', null, { at: NOW, action: CHECK_IN });
    case 'decide':
      return localOutcome('heads_up', 'offline_decide', null, {
        action: { id: 'check_in', label: 'Let in', kind: 'check_in' },
      });
    case 'not-listed':
      return localOutcome('refused', 'not_listed', null, { at: LIST_AT });
    case 'already':
      return localOutcome('heads_up', 'already_done', null, { action: CHECK_IN });
    case 'voided':
      return localOutcome('refused', 'voided', null, { at: LIST_AT });
    default:
      return localOutcome('system', 'network', null);
  }
}

const OFFLINE: ScanState['offline'] = { mode: 'list', listAt: LIST_AT, syncing: false };

function Sheet() {
  return (
    <div className="mx-auto grid max-w-md gap-6 p-5">
      <div className="flex flex-wrap gap-2">
        <SyncChip state={{ kind: 'offline', queued: 3 }} />
        <SyncChip state={{ kind: 'syncing', queued: 3 }} />
        <SyncChip state={{ kind: 'stale', queued: 3 }} />
        <SyncChip state={{ kind: 'conflicts', queued: 2 }} />
      </div>
      <OfflineStatus
        offline={OFFLINE}
        queue={{ pending: 3, oldestAt: NOW - 90_000, conflicts: 2 }}
        onSync={() => undefined}
      />
      <OfflineStatus
        offline={{ mode: 'decide', listAt: null, syncing: true }}
        queue={{ pending: 1, oldestAt: NOW - 20_000, conflicts: 0 }}
        onSync={() => undefined}
      />
    </div>
  );
}

function Admin() {
  const [draft, setDraft] = useState<SessionDraft>({ ...emptySessionDraft(), whenOffline: 'list' });
  return (
    <div className="mx-auto max-w-xl p-5">
      <SessionOfflineFields draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} />
    </div>
  );
}

export function OfflineVisual({ scenario }: { scenario: OfflineScenario }) {
  if (scenario === 'sheet') return <Sheet />;
  if (scenario === 'admin') return <Admin />;
  const pending = scenario === 'queued' ? 4 : 3;
  return (
    <ScanPreviewScreen
      outcome={outcomeOf(scenario)}
      capsuleState="offline"
      chips={<SyncChip state={{ kind: 'offline', queued: pending }} />}
      strip={dockStrip(
        {
          online: false,
          offline: OFFLINE,
          queue: { pending, oldestAt: NOW, conflicts: 0 },
          unsure: [],
        },
        undefined,
        false,
        NOW,
      )}
    />
  );
}
