/** The gallery's hardware views (`?visual=1&surface=hardware&view=&hw=&panel=1`). */
import { useState } from 'react';
import { ScanPreviewScreen } from '../preview-screen.tsx';
import { MenuTrigger } from '../ui/capsule.tsx';
import { CountChip, SyncChip } from '../ui/chips.tsx';
import { OPERATOR_CASES, OperatorVisual } from '../visual-operator.tsx';
import { HARDWARE_CASES, type HardwareCase, hardwareCase } from './fixtures.test-support.ts';
import { guideOf } from './guide.ts';
import { HardwarePanel } from './hardware-panel.tsx';
import { HardwarePill } from './hardware-pill.tsx';
import { hardwareItems } from './items.ts';
import { pillIcons } from './pill-model.ts';

function caseFromUrl(): HardwareCase {
  const hw = new URLSearchParams(location.search).get('hw');
  return HARDWARE_CASES.find((c) => c === hw) ?? 'allowed';
}

/** The pill and panel fed from a fixture, as the scanner shows them. */
export function VisualPill({ operator = false }: { operator?: boolean }) {
  const params = new URLSearchParams(location.search);
  const { probe, live } = hardwareCase(caseFromUrl());
  const items = hardwareItems(probe, { ...live, ...(operator ? { camera: null } : {}) });
  const [open, setOpen] = useState(params.get('panel') === '1');
  const [testing, setTesting] = useState<string | null>(params.get('test'));
  return (
    <>
      <HardwarePill icons={pillIcons(items)} onOpen={() => setOpen(true)} />
      {open ? (
        <HardwarePanel
          items={items}
          steps={guideOf(items, { reads: live.reads, camera: !operator })}
          testing={testing}
          onAction={(item, action) => (action.kind === 'test' ? setTesting(item.id) : undefined)}
          onTestDone={() => setTesting(null)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function HardwareVisual() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? 'scanner';
  const offline = caseFromUrl() === 'offline';
  if (view === 'operator')
    return (
      <OperatorVisual
        scenario={OPERATOR_CASES[0]}
        menu={
          <>
            <VisualPill operator />
            <MenuTrigger />
          </>
        }
      />
    );
  return (
    <ScanPreviewScreen
      outcome={null}
      surface={view === 'desk' ? 'operator' : 'phone'}
      capsuleState={offline ? 'offline' : 'scanning'}
      chips={
        offline ? (
          <SyncChip state={{ kind: 'offline', queued: 3 }} />
        ) : (
          <CountChip count={312} capacity={500} />
        )
      }
      menu={
        <>
          <VisualPill />
          <MenuTrigger />
        </>
      }
    />
  );
}
