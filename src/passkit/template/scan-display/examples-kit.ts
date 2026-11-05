/** The shape of an example and two helpers the example files share. */
import type { Json, ScanAction } from '../../types.ts';
import type { ScanDisplayDoc } from './schema.ts';
import type { ScanDisplayScope } from './text.ts';

export interface ScanExample {
  id: 'vip' | 'gym' | 'coffee' | 'prepaid' | 'coupon' | 'event' | 'voided';
  name: string;
  /** The blueprint (`templates/<slug>`) the example starts from. */
  base: string;
  /** A blueprint that exists today, for tests, until `base` lands. */
  standIn?: string;
  /** JSON Schema properties to add to the blueprint's inputs. */
  inputs: Record<string, Record<string, Json>>;
  /** Pass fields to add to the blueprint's pass.json. */
  fields: {
    group: 'primaryFields' | 'secondaryFields' | 'auxiliaryFields';
    key: string;
    label: string;
    input: string;
  }[];
  actions: ScanAction[];
  sample: Record<string, Json>;
  /** Scope roots beyond the sample, such as history. */
  scope?: ScanDisplayScope;
  display: ScanDisplayDoc;
}

export const text = (extra: Record<string, Json> = {}) => ({ type: 'string', ...extra });
export const CHECK_IN: ScanAction = { id: 'check_in', label: 'Check in', kind: 'check_in' };
