import type { Json } from '../types.ts';

/** JSON Schema keywords that can burn CPU or reach outside the schema. */
const UNSAFE_KEYWORDS = new Set([
  'pattern',
  'patternProperties',
  '$dynamicRef',
  '$recursiveRef',
  '$dynamicAnchor',
  '$recursiveAnchor',
]);
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
const MAX_SCHEMA_NODES = 500;
const MAX_ENUM = 500;

export function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses schema keywords that burn CPU or reach outside, and caps the schema's size. */
export function scanSchema(
  node: unknown,
  path: string,
  options: { allowPattern?: boolean },
  state: { nodes: number },
  report: (code: string, message: string, path: string) => void,
): void {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries())
      scanSchema(child, `${path}/${i}`, options, state, report);
    return;
  }
  if (!isRecord(node)) return;
  if (++state.nodes > MAX_SCHEMA_NODES) {
    if (state.nodes === MAX_SCHEMA_NODES + 1)
      report('SCHEMA_SIZE', `Inputs schema has more than ${MAX_SCHEMA_NODES} nodes.`, path);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (UNSAFE_KEYWORDS.has(key) && !(key === 'pattern' && options.allowPattern))
      report('SCHEMA_KEYWORD', `Inputs schema keyword "${key}" is not allowed.`, `${path}/${key}`);
    else if (key === '$ref' && !(typeof child === 'string' && child.startsWith('#')))
      report('SCHEMA_KEYWORD', 'Only local $ref is allowed.', `${path}/${key}`);
    else if (key === 'format' && child === 'regex')
      report('SCHEMA_KEYWORD', 'format "regex" is not allowed.', `${path}/${key}`);
    else if (key === 'enum' && Array.isArray(child) && child.length > MAX_ENUM)
      report('SCHEMA_SIZE', `enum has more than ${MAX_ENUM} values.`, `${path}/${key}`);
    // Annotations are data, not schemas.
    if (key === 'x-enumLabels' || key === 'default' || key === 'const' || key === 'examples')
      continue;
    if (SCHEMA_MAPS.has(key) && isRecord(child)) {
      for (const [name, sub] of Object.entries(child))
        scanSchema(sub, `${path}/${key}/${name}`, options, state, report);
      continue;
    }
    scanSchema(child, `${path}/${key}`, options, state, report);
  }
}
