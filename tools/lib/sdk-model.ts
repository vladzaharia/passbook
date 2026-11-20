// Language-neutral view of the OpenAPI schemas for the Python and Go SDK generators: every object that
// needs a name gets a declaration, and every other schema becomes a small type tree.
import { pascal } from '../../src/shared/sdk-names.ts';
import type { Schema } from './sdk-ts-schema.ts';

export type Lit = string | number | boolean | null;
export type Ty =
  | { k: 'str' | 'int' | 'num' | 'bool' | 'null' | 'any' }
  | { k: 'ref'; name: string }
  | { k: 'lit'; values: Lit[] }
  | { k: 'list'; of: Ty }
  | { k: 'map'; of: Ty }
  | { k: 'tuple'; of: Ty[]; rest?: Ty }
  | { k: 'union'; of: Ty[] };

export interface Field {
  json: string;
  ty: Ty;
  required: boolean;
}
export type Decl =
  | { kind: 'object'; name: string; fields: Field[] }
  | { kind: 'alias'; name: string; ty: Ty };

const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);

export class Models {
  readonly decls = new Map<string, Decl>();
  private readonly used = new Set<string>();
  private readonly schemas: Record<string, Schema>;

  constructor(schemas: Record<string, Schema>) {
    this.schemas = schemas;
    for (const name of Object.keys(schemas)) this.used.add(name);
    for (const name of Object.keys(schemas).sort())
      this.define(name, schemas[name] as Schema, false);
  }

  /** A name for a declaration nobody has taken. */
  private unique(base: string): string {
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}${n}`;
    this.used.add(name);
    return name;
  }

  private define(name: string, s: Schema, claim: boolean): void {
    if (claim) {
      if (this.used.has(name)) throw new Error(`${name} is also a schema name`);
      this.used.add(name);
    }
    if (!s.$ref && !s.enum && s.const === undefined && isObject(s)) {
      this.decls.set(name, { kind: 'object', name, fields: [] });
      this.decls.set(name, { kind: 'object', name, fields: this.fields(s, name) });
    } else {
      this.decls.set(name, { kind: 'alias', name, ty: this.lower(s, name) });
    }
  }

  private fields(s: Schema, hint: string): Field[] {
    const required = new Set(s.required ?? []);
    return Object.entries(s.properties ?? {}).map(([json, schema]) => ({
      json,
      ty: this.lower(schema, `${hint}${pascal(json)}`),
      required: required.has(json),
    }));
  }

  /** A declaration called exactly `name` for an operation's body, query or result. */
  named(name: string, s: Schema): Ty {
    this.define(name, s, true);
    return { k: 'ref', name };
  }

  /** The declaration behind a reference chain, if any. */
  resolve(ty: Ty): Decl | undefined {
    let cur: Ty = ty;
    while (cur.k === 'ref') {
      const decl = this.decls.get(cur.name);
      if (!decl) return undefined;
      if (decl.kind === 'object') return decl;
      cur = decl.ty;
    }
    return undefined;
  }

  /** The schema a `$ref` chain ends at. */
  schemaOf(s: Schema): Schema {
    let cur = s;
    while (cur.$ref) cur = this.schemas[refName(cur.$ref)] ?? {};
    return cur;
  }

  lower(s: Schema, hint: string): Ty {
    if (s.$ref) return { k: 'ref', name: refName(s.$ref) };
    if (s.const !== undefined) return { k: 'lit', values: [s.const as Lit] };
    if (s.enum) return { k: 'lit', values: s.enum as Lit[] };
    if (s.allOf) throw new Error('allOf is not supported');
    const alternatives = s.anyOf ?? s.oneOf;
    if (alternatives) return union(alternatives.map((a, i) => this.lower(a, `${hint}${i + 1}`)));
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      return union(types.map((t) => this.single(t, s, hint)));
    }
    if (s.properties) return this.single('object', s, hint);
    return { k: 'any' };
  }

  private single(type: string, s: Schema, hint: string): Ty {
    switch (type) {
      case 'string':
        return { k: 'str' };
      case 'integer':
        return { k: 'int' };
      case 'number':
        return { k: 'num' };
      case 'boolean':
        return { k: 'bool' };
      case 'null':
        return { k: 'null' };
      case 'array':
        if (s.prefixItems)
          return {
            k: 'tuple',
            of: s.prefixItems.map((p, i) => this.lower(p, `${hint}${i + 1}`)),
            ...(s.items ? { rest: this.lower(s.items, `${hint}Item`) } : {}),
          };
        return { k: 'list', of: s.items ? this.lower(s.items, `${hint}Item`) : { k: 'any' } };
      case 'object': {
        if (isObject(s)) {
          const name = this.unique(hint);
          this.decls.set(name, { kind: 'object', name, fields: [] });
          this.decls.set(name, { kind: 'object', name, fields: this.fields(s, name) });
          return { k: 'ref', name };
        }
        const extra = s.additionalProperties;
        const typed = extra && typeof extra === 'object' && Object.keys(extra).length > 0;
        return { k: 'map', of: typed ? this.lower(extra, `${hint}Value`) : { k: 'any' } };
      }
      default:
        throw new Error(`Unsupported schema type "${type}"`);
    }
  }
}

const isObject = (s: Schema): boolean =>
  (s.type === 'object' || s.type === undefined) && s.properties !== undefined;

function union(parts: Ty[]): Ty {
  const flat = parts.flatMap((p) => (p.k === 'union' ? p.of : [p]));
  const seen = new Set<string>();
  const of = flat.filter((p) => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return of.length === 1 ? (of[0] as Ty) : { k: 'union', of };
}

/** The refs a type mentions, for ordering declarations. */
export function refsOf(ty: Ty): string[] {
  switch (ty.k) {
    case 'ref':
      return [ty.name];
    case 'list':
    case 'map':
      return refsOf(ty.of);
    case 'tuple':
      return [...ty.of, ...(ty.rest ? [ty.rest] : [])].flatMap(refsOf);
    case 'union':
      return ty.of.flatMap(refsOf);
    default:
      return [];
  }
}
