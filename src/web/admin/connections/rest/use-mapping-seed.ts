import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { MappingRow } from '../../mapping/mapping.ts';
import type { Lifecycle } from '../lifecycle-fields.tsx';
import { type SampleField, seedFromSample } from './mapping-seed.ts';

/**
 * The sample a REST connection took on Configuration. It arrives at Mapping matched: once a template is chosen and a sample was fetched, the
 * empty mapping is filled by the import's matcher. It runs once per template and sample, never over rows
 * the admin has.
 */
export function useRestSample(
  template: { id: string; inputSchema: unknown } | undefined,
  rows: readonly MappingRow[],
  setRows: (rows: MappingRow[]) => void,
  setLife: Dispatch<SetStateAction<Lifecycle>>,
) {
  const [fields, setFields] = useState<SampleField[]>([]);
  const done = useRef('');
  const key = template ? `${template.id}|${fields.map((f) => f.pointer).join()}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on a new template or sample only
  useEffect(() => {
    if (!template || fields.length === 0 || done.current === key) return;
    done.current = key;
    if (rows.length > 0) return;
    const seed = seedFromSample(template.inputSchema, fields);
    setRows(seed.rows);
    if (seed.holderEmailField)
      setLife((l) => (l.holderEmailField ? l : { ...l, holderEmailField: seed.holderEmailField }));
  }, [key]);
  return [fields, setFields] as const;
}
