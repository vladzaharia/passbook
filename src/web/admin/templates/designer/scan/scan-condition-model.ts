import type { ScanCond } from '@/passkit/template/scan-display/schema.ts';
import { splitPath } from '@/passkit/template/scan-display/text.ts';
import { isRecord } from '../model.ts';
import type { Manifest } from './scan-fields.tsx';

export function inputSchema(manifest: Manifest, path: string): Record<string, unknown> {
  const inputs = isRecord(manifest.inputs) ? manifest.inputs : {};
  const properties = isRecord(inputs.properties) ? inputs.properties : {};
  const split = splitPath(path);
  const schema =
    split?.root === 'inputs' && split.rest.length === 1
      ? properties[split.rest[0] ?? '']
      : undefined;
  return isRecord(schema) ? schema : {};
}

export type Leaf = Extract<ScanCond, { path: string } | { input: string }>;
export const isLeaf = (cond: ScanCond): cond is Leaf =>
  isRecord(cond) &&
  (('path' in cond && typeof cond.path === 'string') ||
    ('input' in cond && typeof cond.input === 'string'));
export const leafPath = (leaf: Leaf): string =>
  'input' in leaf ? `inputs.${leaf.input}` : leaf.path;
export const leafOperator = (leaf: Leaf): string =>
  ['eq', 'in', 'empty', 'gt', 'gte', 'lt', 'lte', 'daysFromNow'].find((op) =>
    Object.hasOwn(leaf, op),
  ) ?? 'empty';
export const leafCount = (cond: ScanCond, depth = 0): number => {
  if (depth > 12 || !isRecord(cond)) return 1;
  if ('all' in cond && Array.isArray(cond.all))
    return cond.all.reduce((n, c) => n + leafCount(c, depth + 1), 0);
  if ('any' in cond && Array.isArray(cond.any))
    return cond.any.reduce((n, c) => n + leafCount(c, depth + 1), 0);
  if ('not' in cond) return leafCount(cond.not, depth + 1);
  return 1;
};
export const conditionDepth = (cond: ScanCond, depth = 0): number => {
  if (depth > 12 || !isRecord(cond)) return 1;
  const children: ScanCond[] =
    'all' in cond && Array.isArray(cond.all)
      ? cond.all
      : 'any' in cond && Array.isArray(cond.any)
        ? cond.any
        : 'not' in cond && isRecord(cond.not)
          ? [cond.not]
          : [];
  return children.length
    ? 1 + Math.max(...children.map((child) => conditionDepth(child, depth + 1)))
    : 1;
};
export const firstLeaf = (cond: ScanCond, fallback: Leaf, depth = 0): Leaf => {
  if (depth > 12 || !isRecord(cond)) return fallback;
  if ('all' in cond && Array.isArray(cond.all))
    return cond.all[0] ? firstLeaf(cond.all[0], fallback, depth + 1) : fallback;
  if ('any' in cond && Array.isArray(cond.any))
    return cond.any[0] ? firstLeaf(cond.any[0], fallback, depth + 1) : fallback;
  if ('not' in cond) return firstLeaf(cond.not, fallback, depth + 1);
  return isLeaf(cond) ? cond : fallback;
};
