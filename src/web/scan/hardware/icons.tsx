import {
  Battery,
  BatteryLow,
  Bluetooth,
  Cable,
  Camera,
  Keyboard,
  type LucideIcon,
  Monitor,
  MonitorSmartphone,
  Nfc,
  PlugZap,
  ScanBarcode,
  ScanLine,
  ScanQrCode,
  SmartphoneNfc,
  Sun,
  Usb,
  Vibrate,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { GuideStep } from './guide.ts';
import type { HardwareKind, HardwareState } from './types.ts';

const KIND: Record<HardwareKind, LucideIcon> = {
  camera: Camera,
  wedge: ScanBarcode,
  reader: ScanLine,
  nfc: Nfc,
  keyboard: Keyboard,
  usb: Usb,
  hid: PlugZap,
  serial: Cable,
  bluetooth: Bluetooth,
  battery: Battery,
  screens: Monitor,
  display: MonitorSmartphone,
  network: Wifi,
  sound: Volume2,
  haptics: Vibrate,
  awake: Sun,
};

/** Generic glyphs only: no vendor marks. A few kinds draw their off state. */
export function HardwareIcon({
  kind,
  state,
  size = 16,
}: {
  kind: HardwareKind;
  state: HardwareState;
  size?: number;
}) {
  let Icon = KIND[kind];
  if (kind === 'battery' && state === 'attention') Icon = BatteryLow;
  if (kind === 'network' && state === 'error') Icon = WifiOff;
  if (kind === 'sound' && state === 'off') Icon = VolumeX;
  return <Icon aria-hidden size={size} strokeWidth={2} />;
}

const STEP: Record<GuideStep, LucideIcon> = {
  reader: ScanLine,
  wallet: SmartphoneNfc,
  nfc: Nfc,
  camera: Camera,
  front: Camera,
  handheld: ScanBarcode,
  none: ScanQrCode,
};

export function StepIcon({ step }: { step: GuideStep }) {
  const Icon = STEP[step];
  return <Icon aria-hidden size={20} strokeWidth={2} />;
}
