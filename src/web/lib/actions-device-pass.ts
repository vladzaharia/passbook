import {
  CircleCheck,
  Clock,
  Download,
  type LucideIcon,
  QrCode,
  ShieldAlert,
  Smartphone,
  Unlock,
  X,
} from 'lucide-react';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Workbench device passes: a Test pass on a developer's own phone. */
export const DEVICE_PASS_ACTIONS = {
  'device_pass.created': a('Device pass made', Smartphone, 'success'),
  'device_pass.code_issued': a('Device pass code made', QrCode, 'info'),
  'device_pass.downloaded': a('Device pass opened', Download, 'info'),
  'device_pass.installed': a('Device pass added to a phone', CircleCheck, 'success'),
  'device_pass.voided': a('Device pass voided', X, 'warning'),
  'device_pass.expired': a('Device pass expired', Clock, 'info'),
  'device_pass.overshared': a('Device pass shared', ShieldAlert, 'danger'),
  'device_pass.unblocked': a('Device passes unblocked', Unlock, 'success'),
};
