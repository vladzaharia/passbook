import { Callout } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { readBarcode } from '../ops-more.ts';

/** The offline list holds scan codes and printed codes, never a barcode that is some other number. */
export function OfflineBarcodeNote() {
  const { doc } = useDesigner();
  const barcode = readBarcode(doc);
  if (!barcode.enabled || barcode.message.kind === 'scanCode') return null;
  return <Callout tone="warning">Member-number barcodes can't be checked offline.</Callout>;
}
