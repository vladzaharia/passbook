import * as Primitive from '@radix-ui/react-dropdown-menu';
import {
  Activity,
  BookOpen,
  CameraOff,
  Check,
  Hand,
  LogOut,
  Timer,
  Unplug,
  UserRoundCog,
  Volume2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu.tsx';
import { MenuTrigger } from './capsule.tsx';

export type CameraChoice = 'back' | 'back-wide' | 'front';

export const READER_TIPS = [
  'Hold the top of the iPhone near the reader.',
  'If asked, unlock with Face ID, then hold it near again.',
  'Still nothing? Scan the barcode instead.',
  'No keyboard for Look up? Tap the keyboard button at the bottom of the screen.',
] as const;

const CHECK_ITEM =
  'relative flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-hidden max-sm:min-h-11 pointer-coarse:min-h-11 data-highlighted:bg-state-hover-tint data-highlighted:text-fg-strong [&_svg]:size-4 [&_svg]:shrink-0';

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
  return (
    <Primitive.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
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
  camera: CameraChoice;
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
  return (
    <DropdownMenu {...(p.open === undefined ? {} : { open: p.open })} onOpenChange={p.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <MenuTrigger />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[60] min-w-64">
        <DropdownMenuItem onSelect={p.onShift}>
          <Activity aria-hidden />
          This shift
        </DropdownMenuItem>
        <CheckItem icon={<Volume2 aria-hidden />} checked={p.sound} onCheckedChange={p.onSound}>
          Sound
        </CheckItem>
        <CheckItem
          icon={<Hand aria-hidden />}
          checked={p.holdResults}
          onCheckedChange={p.onHoldResults}
        >
          Keep results until tapped
        </CheckItem>
        <DropdownMenuSeparator />
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
        {p.hasReader ? (
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
        <DropdownMenuItem onSelect={p.onEndShift}>
          <Timer aria-hidden />
          {SCAN_COPY.actions.endShift}
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={p.onLeave}>
          {p.leave === 'unpair' ? <Unplug aria-hidden /> : <LogOut aria-hidden />}
          {p.leave === 'unpair' ? 'Unpair this device' : 'Stop scanning as admin'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
