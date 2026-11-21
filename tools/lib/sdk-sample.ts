// A small value that satisfies a schema, for the SDKs' generated tests: required fields only, the first
// enum member, one array element. Not random and not realistic; it proves a model accepts the shape.
import type { Schema } from './sdk-ts-schema.ts';

const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);

export function sampleOf(
  schemas: Record<string, Schema>,
  s: Schema,
  stack: string[] = [],
): unknown {
  if (s.$ref) {
    const name = refName(s.$ref);
    if (stack.includes(name)) return null;
    return sampleOf(schemas, schemas[name] ?? {}, [...stack, name]);
  }
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  const alternatives = s.anyOf ?? s.oneOf;
  if (alternatives) {
    const first = alternatives.find((a) => a.type !== 'null') ?? alternatives[0];
    return sampleOf(schemas, first ?? {}, stack);
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ['object'] : [];
  switch (types.find((t) => t !== 'null') ?? types[0]) {
    case 'string':
      return 'x';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array': {
      if (s.prefixItems) return s.prefixItems.map((p) => sampleOf(schemas, p, stack));
      const one = s.items ? sampleOf(schemas, s.items, stack) : undefined;
      return one === undefined || one === null ? [] : [one];
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const name of s.required ?? [])
        out[name] = sampleOf(schemas, s.properties?.[name] ?? {}, stack);
      return out;
    }
    default:
      return null;
  }
}
