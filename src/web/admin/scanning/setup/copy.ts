import type { ScanSetupCheck, ScanSetupFix } from '@/shared/contracts/scan-setup-intent.ts';
import { SCAN_SETUP_COPY } from '@/shared/copy/scan-setup.ts';
import type { SetupIssue } from '@/shared/scan-setup-plan-derive.ts';
import { DIRECTION_LABEL } from './draft.ts';

/** `{name}` marks filled from params; an unknown mark stays out of the sentence. */
export const fillCopy = (text: string, params: Record<string, string> = {}): string =>
  text.replace(/\{(\w+)\}/g, (_m, key: string) => params[key] ?? '');

export function checkText(check: ScanSetupCheck): string {
  const text = SCAN_SETUP_COPY.checks[check.message as keyof typeof SCAN_SETUP_COPY.checks];
  return text ? fillCopy(text, check.params) : check.message;
}

/** The button on a check: names the device or person when the fix has one. */
export function fixLabel(fix: ScanSetupFix, names: { device?: string; person?: string }): string {
  switch (fix.kind) {
    case 'device_direction':
      return fillCopy(SCAN_SETUP_COPY.fixes.device_direction, {
        device: names.device ?? 'the device',
        direction: DIRECTION_LABEL[fix.direction],
      });
    case 'add_staff':
      return names.person ? `Make ${names.person} a Manager` : SCAN_SETUP_COPY.fixes.add_staff;
    case 'open_template':
      return fillCopy(SCAN_SETUP_COPY.fixes.open_template, { template: 'the template' });
    default:
      return SCAN_SETUP_COPY.fixes[fix.kind];
  }
}
