import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type * as gates from './repo-gates.ts';
import type { Found } from './resolve.ts';

/** Why a scan that lost the gate is a heads-up, by the rule that decided it. */
export const lostReason = (rule: gates.GateRule): ScanReason =>
  rule.rule === 'once' ? 'already_done' : rule.rule === 'cooldown' ? 'cooldown' : 'in_progress';

export function credentialFacts(
  pass: Found['pass'],
): Partial<Record<'scan_code' | 'barcode_hash' | 'lookup_hash', string>> {
  if (pass.scanCode) return { scan_code: pass.scanCode };
  if (pass.barcodeHash) return { barcode_hash: pass.barcodeHash };
  return {};
}
