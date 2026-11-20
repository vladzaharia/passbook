import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Inputs } from './site.ts';
import {
  type ChangeEntry,
  type Dict,
  type Example,
  METHODS,
  type RawDoc,
  type ReferenceEntry,
  type SdkName,
} from './types.ts';

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const optional = <T>(path: string): T | undefined => (existsSync(path) ? read<T>(path) : undefined);

interface GuideRow {
  id: string;
  title: string;
  guide: string;
  ops: string[];
  files: { ts: string; curl?: string };
}

/** The hand-written snippets listed in `<dir>/index.json`, with their files read. */
function guideExamples(dir: string): Example[] {
  const index = optional<GuideRow[]>(join(dir, 'index.json')) ?? [];
  return index.map((row) => ({
    id: row.id,
    title: row.title,
    guide: row.guide,
    ops: row.ops,
    ts: readFileSync(join(dir, row.files.ts), 'utf8'),
    curl: row.files.curl ? readFileSync(join(dir, row.files.curl), 'utf8') : undefined,
  }));
}

/**
 * The portal's inputs: the OpenAPI snapshot (the keys' view of the API), the frozen SDK names
 * for any operation the snapshot leaves unnamed, and the per-operation reference data. `apiDir`
 * is docs/api; `docsDir` is docs/developers (the changelog until PX12 owns it).
 */
export function loadInputs(root: string, apiDir = 'docs/api', docsDir = 'docs/developers'): Inputs {
  const api = resolve(root, apiDir);
  const doc = read<RawDoc>(join(api, 'openapi.v1.json'));
  const names = read<Record<string, SdkName>>(join(api, 'sdk-names.json'));
  for (const item of Object.values(doc.paths))
    for (const m of METHODS) {
      const op = item[m];
      if (op && !op['x-sdk'] && names[op.operationId]) op['x-sdk'] = names[op.operationId];
    }
  const reference: Record<string, ReferenceEntry> = {};
  const dir = join(api, 'reference');
  if (existsSync(dir))
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort())
      Object.assign(reference, read(join(dir, f)));
  return {
    doc,
    reference,
    changelog: optional<ChangeEntry[]>(join(root, docsDir, 'changelog.json')) ?? [],
    errors: optional(join(api, 'errors.json')),
    guide: optional<Record<string, Dict>>(join(api, 'error-guide.json')),
    examples: guideExamples(join(root, docsDir, 'snippets/guides')),
  };
}
