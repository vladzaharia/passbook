import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Inputs } from './site.ts';
import {
  type ApiVersion,
  type Dict,
  type Example,
  METHODS,
  type RawChangeFile,
  type RawDoc,
  type ReferenceEntry,
  type SdkName,
} from './types.ts';

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const optional = <T>(path: string): T | undefined => (existsSync(path) ? read<T>(path) : undefined);

/** The dated files, not unreleased.json. */
const changeFiles = (dir: string): RawChangeFile[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map((f) => read<RawChangeFile>(join(dir, f)))
    : [];
interface GuideRow {
  id: string;
  title: string;
  guide: string;
  ops: string[];
  files: { ts: string; curl?: string };
}

/** The hand-written snippets listed in `<dir>/index.*.json`, one file per guide, with their files read. */
export function guideExamples(dir: string): Example[] {
  const index = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^index\..+\.json$/.test(f))
        .sort()
        .flatMap((f) => read<GuideRow[]>(join(dir, f)))
    : [];
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
 * for any operation the snapshot leaves unnamed, the per-operation reference data, the dated
 * changelog files and the API versions. `apiDir` is docs/api.
 */
export function loadInputs(root: string, apiDir = 'docs/api'): Inputs {
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
      for (const [id, entry] of Object.entries(read<Record<string, ReferenceEntry>>(join(dir, f))))
        reference[id] = { ...reference[id], ...entry };
  return {
    doc,
    reference,
    changelog: changeFiles(join(api, 'changelog')),
    versions: optional<{ versions: ApiVersion[] }>(join(api, 'versions.json'))?.versions ?? [],
    errors: optional(join(api, 'errors.json')),
    guide: optional<Record<string, Dict>>(join(api, 'error-guide.json')),
    examples: guideExamples(join(root, 'docs/developers/snippets/guides')),
  };
}
