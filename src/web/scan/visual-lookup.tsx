/** The gallery's Look up: the dock button opens the fixture lookup (`?visual=1&surface=scanner`). */
import { LookupSheet } from './lookup/lookup-sheet.tsx';
import { lookupApi } from './visual-trays.tsx';

const API = lookupApi(false);

export function VisualLookup({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <LookupSheet
      open={open}
      api={API}
      allowPeople
      onClose={onClose}
      onCheckIn={onClose}
      onCode={onClose}
    />
  );
}
