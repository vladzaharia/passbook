/** The handheld trays of the visual gallery (`?visual=1&surface=tray&case=`). */
import { useState } from 'react';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import type { ScanApi } from './api/scan-api.ts';
import { LookupSheet } from './lookup/lookup-sheet.tsx';
import { FIXTURE_NOW } from './machine/fixture-data.test-support.ts';
import { fixtureCard, fixtureOutcome } from './machine/fixtures.test-support.ts';
import { ScanPreviewScreen } from './preview-screen.tsx';
import type { DockApproval } from './ui/approval-dock.tsx';
import { MenuTrigger } from './ui/capsule.tsx';
import { CountChip } from './ui/chips.tsx';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';

export const TRAY_CASES = [
  'enter',
  'enter-results',
  'enter-none',
  'enter-confirm',
  'pin',
  'pin-picker',
  'pin-one',
  'pin-wrong',
  'pin-locked',
  'pin-code',
  'pin-nobody',
  'pin-approved',
] as const;
export type TrayCase = (typeof TRAY_CASES)[number];

const ROWS = [
  ['Anna Popescu', 'Gold', 'a***@example.test'],
  ['Anna Park', 'Silver', 'a***@example.test'],
  ['Annabel Reyes', 'Gold', null],
] as const;

function lookupApi(none: boolean): ScanApi {
  const card = fixtureCard();
  return {
    lookup: async () => ({
      items: none
        ? []
        : ROWS.map(([title, subtitle, maskedEmail], i) => ({
            passId: `01900000-0000-7000-8000-0000000000${60 + i}`,
            title,
            subtitle,
            templateName: 'Coffee card',
            status: 'active' as const,
            maskedEmail,
            photoUrl: null,
            doorState: null,
            lastScanAt: null,
          })),
      more: false,
    }),
    resolve: async () => ({
      ...fixtureOutcome('ready', 'choose'),
      kind: 'ready' as const,
      reason: 'choose' as const,
      card,
    }),
  } as unknown as ScanApi;
}

const MANAGERS = [
  { id: 'm1', name: 'Maya Ruiz', role: 'manager' },
  { id: 'm2', name: 'Noor Khan', role: 'manager' },
  { id: 'm3', name: 'Tomas Weber', role: 'manager' },
];

export function TrayVisual({ tray }: { tray: TrayCase }) {
  const base = SCAN_VISUAL_CASES[0]?.outcome;
  const handheld = useMediaQuery(PHONE);
  const [api] = useState(() => lookupApi(tray === 'enter-none'));
  if (!base) return null;
  const d = base.display;
  const outcome = fixtureOutcome('heads_up', 'needs_approval', {
    card: base.card,
    template: base.template,
    approvals: tray !== 'pin-nobody',
    action: { id: 'redeem', label: 'Redeem 1 Free coffee', kind: 'add' },
    ...(d ? { display: { ...d, screen: 'heads_up' as const } } : {}),
  });
  const approval: DockApproval = {
    managers: tray === 'pin-picker' ? MANAGERS : MANAGERS.slice(0, 1),
    code: tray === 'pin-code',
    approvals: 'managers',
    note:
      tray === 'pin-wrong'
        ? { triesLeft: 2 }
        : tray === 'pin-locked'
          ? { locked: true, retryAfterMs: 240_000 }
          : undefined,
    onApprove: () => undefined,
  };
  const enter = tray.startsWith('enter');
  const approved = tray === 'pin-approved';
  return (
    <ScanPreviewScreen
      outcome={enter || approved ? base : outcome}
      {...(approved ? { approvedBy: 'Maya R.' } : {})}
      density={handheld ? 'glance' : 'full'}
      clock={FIXTURE_NOW}
      tint={enter ? 'none' : approved ? 'green' : 'amber'}
      chips={<CountChip count={312} capacity={500} />}
      menu={<MenuTrigger />}
      approval={handheld ? approval : undefined}
    >
      {enter ? (
        <LookupSheet
          open
          api={api}
          allowPeople
          onClose={() => undefined}
          onCheckIn={() => undefined}
          onCode={() => undefined}
        />
      ) : null}
    </ScanPreviewScreen>
  );
}
