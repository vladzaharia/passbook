/** What the console reads at run time: a slim, ref-free slice of one operation. Built by run-spec.ts. */
import type { Json } from '../model/types.ts';

export type { Json };

export interface RunSchema {
  type?: string | string[];
  properties?: Record<string, RunSchema>;
  required?: string[];
  items?: RunSchema;
  enum?: Json[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: RunSchema[];
  anyOf?: RunSchema[];
  nullable?: boolean;
  additionalProperties?: boolean | RunSchema;
  description?: string;
}

export interface RunParam {
  name: string;
  where: 'path' | 'query' | 'header';
  required: boolean;
  schema: RunSchema;
  description: string;
}

export interface RunOp {
  id: string;
  anchor: string;
  title: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The path as the document writes it, `/api/v1/passes/{id}`. */
  path: string;
  idempotent: boolean;
  /** DELETE, void, remove: the Run button asks twice. */
  destructive: boolean;
  params: RunParam[];
  body: RunSchema | null;
  example: Json | undefined;
}

/** `/developers/run/<slug>.json`: one reference page's operations. */
export interface RunFile {
  /** The server origin of the document, for Copy as. Requests go to the page's own origin. */
  origin: string;
  ops: RunOp[];
}

export interface RunIndexItem {
  id: string;
  slug: string;
  anchor: string;
  method: RunOp['method'];
  path: string;
  title: string;
}

/** `/developers/run/index.json`: every runnable operation by group, and the catalog's codes. */
export interface RunIndex {
  groups: { label: string; items: RunIndexItem[] }[];
  codes: string[];
}

export const RUN_DIR = '/developers/run';
