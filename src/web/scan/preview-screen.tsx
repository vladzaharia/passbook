import { type ReactNode, useState } from 'react';
import type { ScanCard } from '../../shared/contracts/scan.ts';
import type { ScanBranding } from '../../shared/contracts/scan-session.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { ScanAppView } from './app.tsx';
import { initialState } from './machine/initial-state.ts';
import { moodOf, viewOf } from './machine/present.ts';
import type { ScanStore } from './machine/store.ts';
import type { ScanOutcome } from './machine/types.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import { scanBrandLogoUrl } from './platform/scan-branding.tsx';
import { ResultCard } from './result/result-card.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import type { StripEntry } from './ui/last-scan-strip.tsx';
import './visual-gallery.css';

const BRANDING: ScanBranding = {
  accent: '#0f766e',
  logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
};
const STRIP: StripEntry = { kind: 'ok', title: 'Taylor Chen', meta: '6:42 PM', undoable: true };

function useStaticStore() {
  const [store] = useState(() => {
    const state = initialState(Date.now());
    const snapshot = { state, view: viewOf(state), now: Date.now() };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      dispatch: () => undefined,
      checkIn: () => undefined,
      configure: () => true,
      retryUnsure: () => undefined,
      dispose: () => undefined,
    } as ScanStore;
  });
  return store;
}

export interface ScanPreviewScreenProps {
  outcome: ScanOutcome;
  /** `phone` is the door and iPad layout; `operator` adds the desk's sidebar. */
  surface?: 'phone' | 'operator';
  phase?: 'up' | 'rising';
  orgName?: string;
  scannerName?: string;
  sidebar?: ReactNode;
  onPass?: (card: ScanCard | null) => void;
}

/**
 * The scanner's loop screen fed one outcome: shell, capsule, camera, result card, buddy and dock,
 * with nothing live behind them. The visual gallery and the template designer's scan preview both
 * paint through it, so a screen cannot look different in the two.
 */
export function ScanPreviewScreen({
  outcome,
  surface = 'phone',
  phase = 'up',
  orgName = 'Northwind Live',
  scannerName = 'West entrance',
  sidebar,
  onPass,
}: ScanPreviewScreenProps) {
  const store = useStaticStore();
  const [runtime] = useState(
    () =>
      ({
        store,
        camera: { hasTorch: () => false, toggleTorch: async () => false },
      }) as unknown as ScanRuntime,
  );
  const mood = moodOf(outcome.kind);
  return (
    <ScanStoreContext.Provider value={store}>
      <ScanAppView
        screen={{ s: 'loop' }}
        surface={surface}
        branding={BRANDING}
        capsule={{
          name: scannerName,
          orgName,
          logoUrl: scanBrandLogoUrl(BRANDING),
          state: 'scanning',
        }}
        camera={<div className="scan-visual-camera" />}
        sidebar={sidebar}
        buddy={
          <Buddy scene="scan" size="xl-scan" mood={mood === 'neutral' ? 'flat' : mood} immediate />
        }
        strip={STRIP}
        dockRow={
          <DoorDock
            outcome={outcome}
            runtime={runtime}
            open={() => undefined}
            onError={() => undefined}
          />
        }
        card={<ResultCard outcome={outcome} phase={phase} onPass={onPass} />}
      />
    </ScanStoreContext.Provider>
  );
}
