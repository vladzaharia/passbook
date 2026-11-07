import type { ReactNode } from 'react';
import type { NativeScannerCapabilities } from '../../shared/contracts/scanning-sessions.ts';
import { type BlockKind, BlockPanel } from './boot/block-panel.tsx';
import { PairConfirm } from './boot/pair-confirm.tsx';
import { PairView } from './boot/pair-view.tsx';
import { Capsule, type CapsuleState } from './ui/capsule.tsx';
import { Dock } from './ui/dock.tsx';
import { LastScanStrip, type StripEntry } from './ui/last-scan-strip.tsx';
import type { Announcement } from './ui/live-announcer.tsx';
import { ScanShell } from './ui/scan-shell.tsx';
import { StartPanel, type StartPanelProps } from './ui/start-panel.tsx';
import type { Tint } from './ui/verdict-tint.tsx';

/** What the boot flow shows before the loop. The machine's `block` and the session decide it. */
export type BootScreen =
  | { s: 'pair'; error?: string | null; busy?: boolean }
  | {
      s: 'confirm';
      scannerName: string;
      orgName: string;
      mode?: 'test' | 'live';
      error?: string | null;
      busy?: boolean;
    }
  | { s: 'block'; kind: BlockKind }
  | ({ s: 'start' } & Omit<StartPanelProps, 'onStart' | 'onDirection'>)
  | { s: 'loop' };

export interface ScanAppViewProps {
  screen: BootScreen;
  /** Present once the device is paired. */
  capsule?: {
    name: string;
    staff?: string | null;
    state: CapsuleState;
    chips?: ReactNode;
    menu?: ReactNode;
    onTitle?: () => void;
  } | null;
  strip?: StripEntry | null;
  /** The dock's thumb row (the door's, the desk's). */
  dockRow?: ReactNode;
  camera?: ReactNode;
  surface?: 'phone' | 'operator' | 'duo';
  layout?: NativeScannerCapabilities['layout'];
  sidebar?: ReactNode;
  card?: ReactNode;
  buddy?: ReactNode;
  tint?: Tint;
  announcement?: Announcement | null;
  on?: {
    pair?: (code: string) => void;
    scanPairingCode?: () => void;
    confirm?: () => void;
    cancelConfirm?: () => void;
    start?: () => void;
    direction?: (d: 'in' | 'out') => void;
    blockAction?: () => void;
    openRecent?: () => void;
    undo?: () => void;
  };
}

/**
 * The scanner's view: the shell with a boot card, Start, or the loop. It holds no state. Stream
 * CC's controller feeds it from the machine and the session; tests feed it from fixtures.
 */
export function ScanAppView({
  screen,
  capsule,
  strip = null,
  dockRow,
  camera,
  surface,
  layout,
  sidebar,
  card,
  buddy,
  tint = 'none',
  announcement = null,
  on = {},
}: ScanAppViewProps) {
  const noop = () => undefined;
  let body: ReactNode = card;
  if (screen.s === 'pair') {
    body = (
      <PairView
        onPair={on.pair ?? noop}
        {...(on.scanPairingCode ? { onScan: on.scanPairingCode } : {})}
        error={screen.error ?? null}
        busy={screen.busy ?? false}
      />
    );
  } else if (screen.s === 'confirm') {
    body = (
      <PairConfirm
        scannerName={screen.scannerName}
        orgName={screen.orgName}
        {...(screen.mode ? { mode: screen.mode } : {})}
        error={screen.error ?? null}
        busy={screen.busy ?? false}
        onPair={on.confirm ?? noop}
        onCancel={on.cancelConfirm ?? noop}
      />
    );
  } else if (screen.s === 'block') {
    body = <BlockPanel kind={screen.kind} onAction={on.blockAction ?? noop} />;
  } else if (screen.s === 'start') {
    const { s: _s, ...rest } = screen;
    body = <StartPanel {...rest} onStart={on.start ?? noop} onDirection={on.direction ?? noop} />;
  }
  const showDock = screen.s === 'start' || screen.s === 'loop';
  return (
    <ScanShell
      surface={surface}
      layout={layout}
      sidebar={screen.s === 'loop' ? sidebar : null}
      camera={screen.s === 'loop' ? camera : null}
      tint={tint}
      cardMode={screen.s === 'loop' ? 'result' : 'boot'}
      card={body}
      dock={
        showDock ? (
          <Dock
            strip={
              <LastScanStrip
                entry={strip}
                {...(on.openRecent ? { onOpen: on.openRecent } : {})}
                {...(on.undo ? { onUndo: on.undo } : {})}
              />
            }
          >
            {screen.s === 'loop' ? dockRow : null}
          </Dock>
        ) : null
      }
      buddy={buddy}
      capsule={
        capsule && (screen.s === 'start' || screen.s === 'loop') ? (
          <Capsule
            name={capsule.name}
            staff={capsule.staff ?? null}
            state={capsule.state}
            chips={capsule.chips}
            menu={capsule.menu}
            {...(capsule.onTitle ? { onTitle: capsule.onTitle } : {})}
          />
        ) : null
      }
      announcement={announcement}
    />
  );
}
