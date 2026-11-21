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
  Sun,
  Usb,
  Vibrate,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
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
