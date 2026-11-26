import { currencyOf, isCurrencyInput } from '@/passkit/template/scan-actions.ts';
import type { ScanAction } from '@/passkit/types.ts';
import { minorDigits } from '@/shared/money.ts';
import { type DesignDoc, isRecord } from '../../model.ts';

/** The currency's minor digits when the action moves a money input, else null. */
export function moneyDigits(doc: DesignDoc, action: ScanAction): number | null {
  if ((action.kind !== 'add' && action.kind !== 'take') || !action.input) return null;
  const props = isRecord(doc.manifest.inputs) ? doc.manifest.inputs.properties : undefined;
  const schema = isRecord(props) ? props[action.input] : undefined;
  if (!isCurrencyInput(schema)) return null;
  return minorDigits(currencyOf(doc.manifest as never, action.input));
}
