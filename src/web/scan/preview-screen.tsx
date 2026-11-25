import { type ReactNode, useState } from 'react';
import type { ScanCard } from '../../shared/contracts/scan.ts';
import type { ScanBranding, ScanSession } from '../../shared/contracts/scan-session.ts';
import { SCAN_COPY } from '../../shared/copy/scan.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import type { ScanApi } from './api/scan-api.ts';
import { ScanAppView, type ScanAppViewProps } from './app.tsx';
import type { ShownDirection } from './machine/direction-view.ts';
import { initialState } from './machine/initial-state.ts';
import { moodOf } from './machine/present.ts';
import { staticStore } from './machine/static-store.ts';
import type { Recent, ScanOutcome } from './machine/types.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { OperatorPanel } from './operator/operator-panel.tsx';
import type { ScanRuntime } from './platform/runtime.ts';
import { scanBrandLogoUrl } from './platform/scan-branding.tsx';
import { ResultCard } from './result/result-card.tsx';
import type { DockApproval } from './ui/approval-dock.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import type { StripEntry } from './ui/last-scan-strip.tsx';
import type { Tint } from './ui/verdict-tint.tsx';
import './visual-gallery.css';

const DEMO_BRANDING: ScanBranding = {
  accent: '#0f766e',
  logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
};
const STRIP: StripEntry = { kind: 'ok', title: 'Taylor Chen', meta: '6:42 PM', undoable: true };

function useStaticStore(recent: Recent[], at: number) {
  const [store] = useState(() => {
    const state = { ...initialState(at), recent };
    return staticStore(state, at);
  });
  return store;
}

export interface ScanPreviewScreenProps {
  /** None: the door is ready for the next code. */
  outcome: ScanOutcome | null;
  /** The camera layer; a plain stage when absent. */
  camera?: ReactNode;
  /** The way the scanner reads, for the dock button and the state line. */
  direction?: { value: ShownDirection; onCycle?: () => void };
  /** `phone` is the door and iPad layout; `operator` adds the desk's sidebar. */
  surface?: 'phone' | 'operator';
  phase?: 'up' | 'rising';
  orgName?: string;
  scannerName?: string;
  /** The org's accent and logo, as the scanner's session carries them. */
  branding?: ScanBranding | null;
  /** Where the logo is served for this viewer; the scanner's own URL when absent. */
  logoUrl?: string | null;
  onPass?: (card: ScanCard | null, outcome: ScanOutcome) => void;
  /** The desk card's Add photo, as a device that may add photos would show it. */
  addPhoto?: ScanApi;
  /** The capsule's state and chips, for screens that show the connection. */
  capsuleState?: 'scanning' | 'offline';
  chips?: ReactNode;
  /** The dock strip; the demo's last scan when absent. */
  strip?: StripEntry | null;
  /** `glance` is the handheld's card; the designer's phone preview keeps the full card. */
  density?: 'full' | 'glance';
  /** The capsule's menu trigger. */
  menu?: ReactNode;
  /** A tap on the tint outside the card. */
  onTint?: () => void;
  /** The verdict wash and ring; none when absent. */
  tint?: Tint;
  /** The clock "12 min ago" reads from; now when absent. */
  clock?: number;
  /** The device's recent scans, for the pass sheet's Recent tab. */
  recent?: Recent[];
  /** Sunlight mode and the mirrored thumb row, as a handheld's device settings set them. */
  look?: ScanAppViewProps['look'];
  /** A handheld's Manager PIN: the dock offers the tray for a `needs_approval` hold. */
  approval?: DockApproval;
  /** The dock's Look up; the gallery opens its fixture lookup, a preview leaves it inert. */
  onLookup?: () => void;
  /** A Manager's PIN let this through: the sub names them. */
  approvedBy?: string;
  /** Rendered inside the scan store: sheets that read it. */
  children?: ReactNode;
}

function OperatorSidebar({
  outcome,
  orgName,
  runtime,
}: {
  outcome: ScanOutcome | null;
  orgName: string;
  runtime: ScanRuntime;
}) {
  const [api] = useState(
    () =>
      ({
        activity: async () => ({
          items: [
            {
              id: '01900000-0000-7000-8000-000000000002',
              at: Date.now(),
              deviceId: '01900000-0000-7000-8000-000000000001',
              deviceName: 'West entrance',
              passId: '01900000-0000-7000-8000-000000000001',
              title: `${outcome?.display?.identity.holder ?? 'Pass'} · accepted`,
              outcome: 'ok',
              direction: 'in',
            },
          ],
        }),
        lookup: async () => ({ items: [], more: false }),
      }) as unknown as ScanApi,
  );
  const [session] = useState(
    () =>
      ({
        principal: 'admin',
        state: 'ready',
        scanner: {
          orgName,
          settings: { lookup: true, flow: 'auto', roleWithoutSignIn: 'door' },
        },
        staff: null,
        staffList: null,
      }) as unknown as ScanSession,
  );
  return <OperatorPanel api={api} runtime={runtime} session={session} />;
}

/**
 * The scanner's loop screen fed one outcome: shell, capsule, camera, result card, buddy and dock,
 * with nothing live behind them. The visual gallery and the template designer's scan preview both
 * paint through it, so a screen cannot look different in the two.
 */
export function ScanPreviewScreen({
  outcome,
  camera,
  direction,
  surface = 'phone',
  phase = 'up',
  orgName = 'Northwind Live',
  scannerName = 'West entrance',
  branding = DEMO_BRANDING,
  logoUrl,
  onPass,
  addPhoto,
  capsuleState = 'scanning',
  chips,
  strip = STRIP,
  density = 'full',
  recent = [],
  tint = 'none',
  menu,
  onTint,
  clock,
  approval,
  onLookup,
  approvedBy,
  look,
  children,
}: ScanPreviewScreenProps) {
  const store = useStaticStore(recent, clock ?? Date.now());
  const [runtime] = useState(
    () =>
      ({
        store,
        camera: { hasTorch: () => false, toggleTorch: async () => false },
      }) as unknown as ScanRuntime,
  );
  const mood = moodOf(outcome?.kind ?? 'ready');
  return (
    <ScanStoreContext.Provider value={store}>
      <ScanAppView
        screen={{ s: 'loop' }}
        surface={surface}
        branding={branding}
        tint={tint}
        look={look}
        {...(onTint ? { onTint } : {})}
        capsule={{
          name: scannerName,
          orgName,
          logoUrl: logoUrl !== undefined ? logoUrl : scanBrandLogoUrl(branding),
          state: capsuleState,
          ...(direction && !direction.onCycle
            ? { direction: SCAN_COPY.direction[direction.value] }
            : {}),
          ...(chips ? { chips } : {}),
          ...(menu ? { menu } : {}),
        }}
        camera={camera ?? <div className="scan-visual-camera" />}
        sidebar={
          surface === 'operator' ? (
            <OperatorSidebar outcome={outcome} orgName={orgName} runtime={runtime} />
          ) : null
        }
        buddy={
          <Buddy scene="scan" size="xl-scan" mood={mood === 'neutral' ? 'flat' : mood} immediate />
        }
        strip={strip}
        dockRow={
          <DoorDock
            outcome={outcome}
            runtime={runtime}
            open={onLookup ?? (() => undefined)}
            onError={() => undefined}
            approval={approval}
            handheld={density === 'glance'}
            direction={direction}
          />
        }
        card={
          outcome ? (
            <ResultCard
              outcome={outcome}
              phase={phase}
              onPass={onPass}
              onGroup={() => undefined}
              addPhoto={addPhoto}
              density={density}
              approvedBy={approvedBy}
              {...(clock ? { clock } : {})}
            />
          ) : null
        }
      />
      {children}
    </ScanStoreContext.Provider>
  );
}
