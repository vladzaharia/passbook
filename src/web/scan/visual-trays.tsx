/** The handheld trays of the visual gallery (`?visual=1&surface=tray&case=`). */
import { useEffect, useState } from 'react';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import type { ScanApi } from './api/scan-api.ts';
import { LookupSheet } from './lookup/lookup-sheet.tsx';
import { FIXTURE_NOW } from './machine/fixture-data.test-support.ts';
import { fixtureCard, fixtureOutcome } from './machine/fixtures.test-support.ts';
import { ScanPreviewScreen } from './preview-screen.tsx';
import type { DockApproval } from './ui/approval-dock.tsx';
import { MenuTrigger } from './ui/capsule.tsx';
import { CountChip } from './ui/chips.tsx';
import { ScanMenu } from './ui/scan-menu.tsx';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';
import { lookFromUrl } from './visual-handheld.ts';

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
  'menu',
] as const;
export type TrayCase = (typeof TRAY_CASES)[number];

const ROWS = [
  ['Anna Popescu', 'Gold', 'a***@example.test'],
  ['Anna Park', 'Silver', 'a***@example.test'],
  ['Annabel Reyes', 'Gold', null],
] as const;

export function lookupApi(none: boolean): ScanApi {
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

/** The scanner menu open, with the handheld's settings as a phone shows them. */
function OpenMenu() {
  const [look, setLook] = useState(lookFromUrl);
  return (
    <ScanMenu
      sound
      onSound={() => undefined}
      holdResults={false}
      onHoldResults={() => undefined}
      camera="back"
      onCamera={() => undefined}
      onShift={() => undefined}
      onEndShift={() => undefined}
      leave="unpair"
      onLeave={() => undefined}
      canSwitchStaff
      open
      handheld={{
        sunlight: look.sun,
        leftHand: look.leftHand,
        onSunlight: (sun) => setLook({ ...look, sun }),
        onLeftHand: (leftHand) => setLook({ ...look, leftHand }),
        canBuzz: new URLSearchParams(location.search).get('buzz') !== '0',
      }}
    />
  );
}

/** What a named tray needs done after it mounts: a name typed and a row picked, or the PIN button pressed. */
function DemoSteps({ tray }: { tray: TrayCase }) {
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (tray === 'enter-results' || tray === 'enter-confirm')
      timers.push(
        setTimeout(() => {
          const field = document.querySelector<HTMLInputElement>(
            'input[type="text"], input:not([type])',
          );
          if (!field) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            field,
            'Ann',
          );
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }, 300),
      );
    if (tray === 'enter-confirm')
      timers.push(
        setTimeout(() => document.querySelector<HTMLElement>('[data-lookup-result]')?.click(), 900),
      );
    if (['pin', 'pin-picker', 'pin-one', 'pin-code'].includes(tray))
      timers.push(
        setTimeout(
          () => document.querySelector<HTMLElement>('.scan-dock [aria-haspopup="dialog"]')?.click(),
          400,
        ),
      );
    return () => timers.forEach(clearTimeout);
  }, [tray]);
  return null;
}

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
      outcome={tray === 'menu' ? null : enter || approved ? base : outcome}
      {...(approved ? { approvedBy: 'Maya R.' } : {})}
      density={handheld ? 'glance' : 'full'}
      clock={FIXTURE_NOW}
      tint={enter || tray === 'menu' ? 'none' : approved ? 'green' : 'amber'}
      chips={<CountChip count={312} capacity={500} />}
      look={lookFromUrl()}
      menu={tray === 'menu' ? <OpenMenu /> : <MenuTrigger />}
      approval={handheld ? approval : undefined}
    >
      <DemoSteps tray={tray} />
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
