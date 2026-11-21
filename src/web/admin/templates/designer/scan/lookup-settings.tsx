import { useDesigner } from '../context.tsx';
import { PickEdit } from '../controls.tsx';
import { lookupInput, lookupInputs } from './lookup.ts';

export function LookupSettings() {
  const { doc, edit } = useDesigner();
  return (
    <PickEdit
      label="Lookup ID"
      value={lookupInput(doc.manifest) || '__none'}
      options={[{ value: '__none', label: 'None' }, ...lookupInputs(doc.manifest)]}
      help="Extra identifier for scanning, apart from the barcode. Use text to keep leading zeros."
      onPick={(input) => edit({ op: 'scan-lookup', input: input === '__none' ? '' : input })}
    />
  );
}
