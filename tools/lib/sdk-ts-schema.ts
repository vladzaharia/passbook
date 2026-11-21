// JSON Schema (the subset docs/api/openapi.v1.json uses) to TypeScript type text, for tools/gen-sdk-ts.ts.

export interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  prefixItems?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const key = (name: string): string => (IDENT.test(name) ? name : JSON.stringify(name));
const pad = (depth: number): string => '  '.repeat(depth);
const isOpen = (extra: boolean | Schema | undefined): boolean =>
  extra === true || (typeof extra === 'object' && Object.keys(extra).length === 0);

function objectType(s: Schema, depth: number): string {
  const props = Object.entries(s.properties ?? {});
  const extra = s.additionalProperties;
  const typedExtra = extra && typeof extra === 'object' && !isOpen(extra) ? extra : undefined;
  if (props.length === 0) {
    return `Record<string, ${typedExtra ? tsType(typedExtra, depth) : 'unknown'}>`;
  }
  const required = new Set(s.required ?? []);
  const lines = props.map(
    ([name, schema]) =>
      `${pad(depth + 1)}${key(name)}${required.has(name) ? '' : '?'}: ${tsType(schema, depth + 1)};`,
  );
  if (isOpen(extra)) lines.push(`${pad(depth + 1)}[key: string]: unknown;`);
  const body = `{\n${lines.join('\n')}\n${pad(depth)}}`;
  return typedExtra ? `${body} & Record<string, ${tsType(typedExtra, depth)}>` : body;
}

function arrayType(s: Schema, depth: number): string {
  if (s.prefixItems) {
    const head = s.prefixItems.map((item) => tsType(item, depth));
    const rest = s.items ? [`...Array<${tsType(s.items, depth)}>`] : [];
    return `[${[...head, ...rest].join(', ')}]`;
  }
  return `Array<${s.items ? tsType(s.items, depth) : 'unknown'}>`;
}

function single(type: string, s: Schema, depth: number): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return arrayType(s, depth);
    case 'object':
      return objectType(s, depth);
    default:
      throw new Error(`Unsupported schema type "${type}"`);
  }
}

const union = (parts: string[]): string => [...new Set(parts)].join(' | ');

/** `depth` is the indent of the line the type starts on. */
export function tsType(s: Schema, depth = 0): string {
  if (s.$ref) return s.$ref.slice(s.$ref.lastIndexOf('/') + 1);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return union(s.enum.map((v) => JSON.stringify(v)));
  const alternatives = s.anyOf ?? s.oneOf;
  if (alternatives) return union(alternatives.map((a) => tsType(a, depth)));
  if (s.allOf) return s.allOf.map((a) => `(${tsType(a, depth)})`).join(' & ');
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    return union(types.map((t) => single(t, s, depth)));
  }
  if (s.properties) return objectType(s, depth);
  return 'unknown';
}
