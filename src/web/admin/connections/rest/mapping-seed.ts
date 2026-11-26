import type { Json } from '@/shared/contracts/common.ts';
import { planOfSuggestion, suggestMapping } from '@/shared/issuing/matcher.ts';
import { pointerOfKey } from '@/shared/mapping/pointer.ts';
import { type Mapping, type MappingRow, toRows } from '../../mapping/mapping.ts';

/** A field of the sampled records: where it is in a record, and up to three values it holds. */
export interface SampleField {
  pointer: string;
  label: string;
  samples: string[];
  /** The first value, for the Mapping step's source list. */
  preview: string;
}

export interface MappingSeed {
  rows: MappingRow[];
  /** The pointer of the holder email in a record, when one matched. */
  holderEmailField: string;
}

/**
 * Mapping rows for a template from the sample, through the matcher the import uses: by name, then by
 * what the values look like. A column's pointer in the matcher is its label's, so it maps back to the
 * field's own pointer, which is what a sync reads.
 */
export function seedFromSample(
  inputSchema: unknown,
  fields: readonly SampleField[],
  holderEmail?: string,
): MappingSeed {
  const back = new Map(fields.map((f) => [pointerOfKey(f.label), f.pointer]));
  const rows = [0, 1, 2].map((i) => fields.map((f) => f.samples[i] ?? ''));
  const s = suggestMapping(
    inputSchema,
    fields.map((f) => f.label),
    rows,
  );
  const real = (p: string) => back.get(p) ?? p;
  const plan = planOfSuggestion(s);
  const mapping: Mapping = {};
  for (const [input, entry] of Object.entries(plan.mapping)) {
    const options = entry.transform?.options;
    const joined = Array.isArray(options?.with) ? (options.with as string[]) : undefined;
    mapping[input] = {
      ...entry,
      from: real(entry.from),
      ...(entry.transform
        ? {
            transform: {
              ...entry.transform,
              ...(joined ? { options: { ...options, with: joined.map(real) as Json } } : {}),
            },
          }
        : {}),
    } as Mapping[string];
  }
  const email = plan.holderEmail ? real(plan.holderEmail.from) : (holderEmail ?? '');
  return { rows: toRows(mapping), holderEmailField: email };
}
