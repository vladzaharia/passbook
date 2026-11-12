import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { barcodeHashOfCode, cleanCode, codeKeyOf, lookupHashOf } from './codes.ts';
import type * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import type { ScanPresenceSnapshot } from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import type { ScanCredentialColumn } from './scan-pass-checks.ts';
import { admissionConds, overrideOpen } from './scan-write-statements.ts';

/** Why a scan that lost the gate is a heads-up, by the rule that decided it. */
export const lostReason = (rule: gates.GateRule): ScanReason =>
  rule.rule === 'once' ? 'already_done' : rule.rule === 'cooldown' ? 'cooldown' : 'in_progress';

/**
 * What let this scan in, repeated at commit, and the heads-up it gets when another scan took it
 * first: the reason a fresh evaluation would give (inside already, gone already, or used up).
 */
export function commitConditions(
  passId: string,
  plan: AdmissionPlan | undefined,
  presenceBefore: ScanPresenceSnapshot | null,
  overrideOf: string | null,
): { conds: GrantCond[]; reason: ScanReason } {
  const conds = [
    ...(plan ? admissionConds(passId, plan, presenceBefore) : []),
    ...(overrideOf ? [overrideOpen(overrideOf)] : []),
  ];
  const entering = plan?.state.direction === 'in';
  const reason: ScanReason = plan?.tracked
    ? entering
      ? 'still_inside'
      : 'not_inside'
    : (plan?.limited && entering) || overrideOf
      ? 'already_done'
      : 'in_progress';
  return { conds, reason };
}

/**
 * The one credential column the scanned code matched (F3 rev 2), in resolve's lookup order: scan
 * code, barcode hash, lookup hash, each against the value read with the candidate. A serial match
 * names no credential column.
 */
export async function credentialFacts(
  pass: Found['pass'],
  candidate: Pick<Candidate, 'lookupHash'> | null,
  code: string,
): Promise<Partial<Record<ScanCredentialColumn, string>>> {
  const clean = cleanCode(code);
  const key = codeKeyOf(clean);
  if (key && pass.scanCode === key) return { scan_code: key };
  const barcode = await barcodeHashOfCode(clean);
  if (pass.barcodeHash === barcode) return { barcode_hash: barcode };
  const lookup = await lookupHashOf(clean);
  if (candidate?.lookupHash === lookup) return { lookup_hash: lookup };
  return {};
}
