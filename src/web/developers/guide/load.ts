import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { guideExamples } from '../model/load.ts';
import type { Example } from '../model/types.ts';
import { type GuideDoc, parseGuide } from './parse.ts';
import { expandSetupDirective } from './webhook-setup.ts';

export const GUIDES_DIR = 'docs/developers/guides';

/** What the build and the checker read: every guide file, parsed, in the portal's order, and the snippets they point at. */
export interface GuideInputs {
  docs: { file: string; doc: GuideDoc }[];
  examples: Example[];
}

/** The guide files as text, for the checker, which reports a bad file instead of stopping. */
export function readGuideFiles(root: string): { file: string; text: string }[] {
  const dir = join(root, GUIDES_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      file: `${GUIDES_DIR}/${f}`,
      text: expandSetupDirective(readFileSync(join(dir, f), 'utf8')),
    }));
}

export function loadGuideInputs(root: string): GuideInputs {
  const order = (id: string) => {
    const i = DEV_GUIDES.findIndex((g) => g.id === id);
    return i < 0 ? DEV_GUIDES.length : i;
  };
  const docs = readGuideFiles(root).map(({ file, text }) => ({
    file,
    doc: parseGuide(text, file),
  }));
  docs.sort((a, b) => order(a.doc.meta.id) - order(b.doc.meta.id));
  return { docs, examples: guideExamples(join(root, 'docs/developers/snippets/guides')) };
}
