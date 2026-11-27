import type { DesignDoc, Dict } from '../../admin/templates/designer/model.ts';
import { isRecord } from '../../admin/templates/designer/model.ts';

/** The sample input a template carries: what every preview and the code samples draw from. */
export function sampleOf(doc: DesignDoc): Dict {
  return isRecord(doc.manifest.sample) ? doc.manifest.sample : {};
}

/** The sample as JSON text, two-space indented, as the JSON view shows it. */
export const sampleText = (doc: DesignDoc): string => JSON.stringify(sampleOf(doc), null, 2);

export type SampleParse = { ok: true; sample: Dict } | { ok: false; problem: string };

/** What a person typed in the JSON view: an object becomes the sample, anything else says why not. */
export function parseSample(text: string): SampleParse {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ok: false, problem: 'The sample is an object.' };
    return { ok: true, sample: value };
  } catch {
    return { ok: false, problem: 'Not valid JSON yet.' };
  }
}
