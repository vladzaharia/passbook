/** What the Require… menu offers: the capabilities this template uses and nothing already required. */
import { CAPABILITY_IDS, type WalletPassView } from '@/passkit/wallets/types.ts';
import { capabilityLabel } from '@/shared/copy/wallets.ts';

export interface CapabilityOption {
  value: string;
  label: string;
}

export function capabilityOptions(
  view: WalletPassView,
  required: readonly string[],
): CapabilityOption[] {
  const used = new Set<string>(['type']);
  for (const role of Object.keys(view.roles)) used.add(`role.${role}`);
  if (view.barcodes.length > 0) used.add('barcode.format');
  for (const slot of Object.keys(view.images.apple)) used.add(`image.${slot}`);
  if (view.relevance.dates.length > 0) used.add('relevance.dates');
  if (view.relevance.locations.length > 0) used.add('relevance.locations');
  if (view.validity.expirationDate) used.add('validity.expiration');
  if (view.fields.some((f) => f.changeMessage)) used.add('messaging.notify');
  return CAPABILITY_IDS.filter((id) => used.has(id) && !required.includes(id)).map((id) => ({
    value: id,
    label: capabilityLabel(id),
  }));
}
