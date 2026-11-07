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
      help="An extra identifier for scanning or lookup. It can differ from the barcode and stay off the pass. Use text to preserve leading zeros."
      onPick={(input) => edit({ op: 'scan-lookup', input: input === '__none' ? '' : input })}
    />
  );
}
