import { resolve } from 'node:path';
import { blueprintPreviews } from './build.tsx';
import type { BlueprintPreviews } from './model.ts';

export const ORIGIN = 'https://passbook.mobile';
export const ROOT = resolve(import.meta.dirname, '../../../..');

let built: { data: BlueprintPreviews; files: Map<string, string> } | undefined;

/** What the deploy step writes: the previews file and the paper images, built once per test file. */
export function builtPreviews() {
  if (!built) {
    const out = blueprintPreviews(ROOT, ORIGIN);
    built = {
      data: JSON.parse(out.json) as BlueprintPreviews,
      files: new Map(out.files.map((f) => [f.file, f.body])),
    };
  }
  return built;
}
