import { useMemo, useState } from 'react';
import { Input, Select } from '../../../ui/index.ts';
import { browserZone, isoToLocal, localToIso, zoneList } from './datetime.ts';

interface Props {
  value: string;
  onValue: (v: string | undefined) => void;
  disabled?: boolean | undefined;
  onBlur: () => void;
  [key: string]: unknown;
}

/** Stores a UTC ISO instant; the admin reads and edits it in a chosen zone. */
export function DateTimeInput({ value, onValue, disabled, onBlur, ...control }: Props) {
  const [zone, setZone] = useState(browserZone);
  const zones = useMemo(() => zoneList(zone), [zone]);
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? isoToLocal(value, zone);
  return (
    <div className="flex flex-wrap gap-2">
      <Input
        {...control}
        type="datetime-local"
        disabled={disabled}
        onBlur={() => {
          setDraft(undefined);
          onBlur();
        }}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value);
          onValue(e.target.value ? localToIso(e.target.value, zone) : undefined);
        }}
        className="min-w-0 flex-1"
      />
      <Select
        aria-label="Time zone"
        className="w-52"
        disabled={disabled}
        value={zone}
        onValueChange={(z) => {
          setZone(z);
          setDraft(undefined);
        }}
        options={zones.map((z) => ({ value: z, label: z }))}
      />
    </div>
  );
}
