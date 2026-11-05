/**
 * DM section 8 as data: the six owner examples and the voided case. Each is a blueprint (`base`)
 * plus the inputs, actions and sample it needs, so the sheets match (UI.6), the editor's op tests
 * (TD.2) and the e2e fixture templates (IN.1) start from the same documents.
 */
import type { TemplateManifest } from '../../types.ts';
import { EVENT_EXAMPLES } from './examples-event.ts';
import type { ScanExample } from './examples-kit.ts';
import { PEOPLE_EXAMPLES } from './examples-people.ts';
import { VALUE_EXAMPLES } from './examples-value.ts';

export type { ScanExample } from './examples-kit.ts';

export const EXAMPLES: ScanExample[] = [...PEOPLE_EXAMPLES, ...VALUE_EXAMPLES, ...EVENT_EXAMPLES];

/** A manifest for the example: the blueprint plus the example's inputs, actions and display. */
export function exampleManifest(base: TemplateManifest, example: ScanExample): TemplateManifest {
  const properties = { ...(base.inputs.properties ?? {}), ...example.inputs };
  return {
    ...base,
    inputs: { ...base.inputs, properties },
    sample: { ...base.sample, ...example.sample },
    scan: { ...base.scan, actions: example.actions, display: example.display },
  };
}
