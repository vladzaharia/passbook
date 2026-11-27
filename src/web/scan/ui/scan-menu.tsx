import * as Primitive from '@radix-ui/react-dropdown-menu';
import {
  Activity,
  ArrowLeftRight,
  BookOpen,
  CameraOff,
  Check,
  Hand,
  LogOut,
  MonitorSmartphone,
  Nfc,
  Sun,
  Timer,
  Unplug,
  UserRoundCog,
  Volume2,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useIgnoreOpeningGesture,
} from '../../ui/dropdown-menu.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { MenuTrigger } from './capsule.tsx';

const FlipSheet = lazy(() =>
  import('../role/flip-sheet.tsx').then((m) => ({ default: m.FlipSheet })),
);

export type CameraChoice = 'back' | 'back-wide' | 'front';

export const READER_TIPS = [
  'Hold the top of the iPhone near the reader.',
  'If asked, unlock with Face ID, then hold it near again.',
  'Still nothing? Scan the barcode instead.',
  'Or enter a code, name or full email.',
] as const;

const CHECK_ITEM =
  'relative flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base text-fg outline-hidden max-sm:min-h-11 pointer-coarse:min-h-11 data-highlighted:bg-state-hover-tint data-highlighted:text-fg-strong [&_svg]:size-4 [&_svg]:shrink-0';

function CheckItem({
  icon,
  checked,
  onCheckedChange,
  children,
}: {
  icon: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  children: ReactNode;
}) {
  const opening = useIgnoreOpeningGesture();
  return (
    <Primitive.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      {...opening}
      className={CHECK_ITEM}
    >
      <span className="text-fg-muted">{icon}</span>
      <span className="flex-1">{children}</span>
      <Primitive.ItemIndicator>
        <Check aria-hidden className="text-accent-fg" />
      </Primitive.ItemIndicator>
    </Primitive.CheckboxItem>
  );
}

export interface ScanMenuProps {
  sound: boolean;
  onSound: (v: boolean) => void;
  holdResults: boolean;
  onHoldResults: (v: boolean) => void;
  /** A handheld: its own settings, and a note when the device cannot buzz. */
  handheld?: {
    sunlight: boolean;
    onSunlight: (v: boolean) => void;
    leftHand: boolean;
    onLeftHand: (v: boolean) => void;
    canBuzz: boolean;
  };
  camera: CameraChoice;
  cameraAvailable?: boolean;
  hasWide?: boolean;
  onCamera: (v: CameraChoice) => void;
  /** The scanner has a reader: Camera off and Reader tips show. */
  hasReader?: boolean;
  cameraOff?: boolean;
  onCameraOff?: (v: boolean) => void;
  onReaderTips?: () => void;
  /** Staff sign-in is on. */
  canSwitchStaff?: boolean;
  onSwitchStaff?: () => void;
  /** A paired phone can face a customer; absent for terminals and admin sessions. */
  flip?: { api: ScanApi; refetch: () => Promise<void> };
  /** Assign tag: absent when this scanner cannot assign; disabled offline. */
  tags?: { offline: boolean; onSelect: () => void } | null;
  onShift: () => void;
  onEndShift: () => void;
  /** The last item: a paired device unpairs, an admin stops scanning as admin. */
  leave: 'unpair' | 'stop-admin';
  onLeave: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** One list: an action sheet on a phone, a dropdown from 640 px (the kit's menu does both). */
export function ScanMenu(p: ScanMenuProps) {
  const [flipOpen, setFlipOpen] = useState(false);
  return (
    <>
      <DropdownMenu
        {...(p.open === undefined ? {} : { open: p.open })}
        onOpenChange={p.onOpenChange}
      >
        <DropdownMenuTrigger asChild>
          <MenuTrigger />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="z-[60] min-w-72 [&_[role=menuitem]]:min-h-11 [&_[role=menuitem]]:text-base"
        >
          <DropdownMenuItem onSelect={p.onShift}>
            <Activity aria-hidden />
            This shift
          </DropdownMenuItem>
          {p.tags ? (
            <DropdownMenuItem
              disabled={p.tags.offline}
              onSelect={p.tags.onSelect}
              data-testid="scan-menu-assign-tag"
            >
              <Nfc aria-hidden />
              {SCAN_TAG_COPY.menu.assign}
              {p.tags.offline ? (
                <span className="ms-auto text-xs text-fg-muted">{SCAN_TAG_COPY.menu.offline}</span>
              ) : null}
            </DropdownMenuItem>
          ) : null}
          <CheckItem icon={<Volume2 aria-hidden />} checked={p.sound} onCheckedChange={p.onSound}>
            Sound
            {p.handheld && !p.handheld.canBuzz ? (
              <span className="block text-sm text-fg-muted">
                {SCAN_HANDHELD_COPY.menu.noVibration}
              </span>
            ) : null}
          </CheckItem>
          <CheckItem
            icon={<Hand aria-hidden />}
            checked={p.holdResults}
            onCheckedChange={p.onHoldResults}
          >
            Keep results until tapped
          </CheckItem>
          {p.handheld ? (
            <>
              <CheckItem
                icon={<Sun aria-hidden />}
                checked={p.handheld.sunlight}
                onCheckedChange={p.handheld.onSunlight}
              >
                {SCAN_HANDHELD_COPY.menu.sunlight}
              </CheckItem>
              <CheckItem
                icon={<ArrowLeftRight aria-hidden />}
                checked={p.handheld.leftHand}
                onCheckedChange={p.handheld.onLeftHand}
              >
                {SCAN_HANDHELD_COPY.menu.leftHand}
              </CheckItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          {p.cameraAvailable !== false ? (
            <>
              <DropdownMenuLabel>Camera</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={p.camera}
                onValueChange={(v) => p.onCamera(v as CameraChoice)}
              >
                <DropdownMenuRadioItem value="back">Back</DropdownMenuRadioItem>
                {p.hasWide !== false ? (
                  <DropdownMenuRadioItem value="back-wide">Back wide</DropdownMenuRadioItem>
                ) : null}
                <DropdownMenuRadioItem value="front">Front</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </>
          ) : null}
          {p.hasReader && p.cameraAvailable !== false ? (
            <>
              <CheckItem
                icon={<CameraOff aria-hidden />}
                checked={p.cameraOff ?? false}
                onCheckedChange={(v) => p.onCameraOff?.(v)}
              >
                Camera off
              </CheckItem>
              <DropdownMenuItem onSelect={p.onReaderTips}>
                <BookOpen aria-hidden />
                Reader tips
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          {p.canSwitchStaff ? (
            <DropdownMenuItem onSelect={p.onSwitchStaff}>
              <UserRoundCog aria-hidden />
              Switch staff
            </DropdownMenuItem>
          ) : null}
          {p.flip ? (
            <DropdownMenuItem onSelect={() => setFlipOpen(true)}>
              <MonitorSmartphone aria-hidden />
              {SCAN_COPY.changeMode.menu}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={p.onEndShift}>
            <Timer aria-hidden />
            {SCAN_COPY.actions.endShift}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={p.onLeave}>
            {p.leave === 'unpair' ? <Unplug aria-hidden /> : <LogOut aria-hidden />}
            {p.leave === 'unpair' ? 'Unpair this device' : 'Stop scanning as admin'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {p.flip && flipOpen ? (
        <Suspense fallback={null}>
          <FlipSheet open {...p.flip} onClose={() => setFlipOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
