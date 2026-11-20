import type { RunOp } from '../console/types.ts';

/** The slice of OpenAPI the portal reads, and the view models it builds. Build-time only. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Dict = Record<string, unknown>;

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type Method = (typeof METHODS)[number];

export interface SdkName {
  resource: string;
  method: string;
  sdk?: boolean;
  reason?: string;
}

export interface RawOp {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Dict[];
  requestBody?: Dict;
  responses?: Record<string, Dict>;
  security?: Record<string, string[]>[];
  deprecated?: boolean;
  'x-sdk'?: SdkName;
  'x-codes'?: unknown;
}

export interface RawDoc {
  info: { title: string; version: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, RawOp>>;
  webhooks?: Record<string, Record<string, Dict>>;
  components: { schemas: Record<string, Dict>; parameters?: Record<string, Dict> };
}

/** docs/api/reference/*.json: per operation id, merged over the document where it is silent. */
export interface ReferenceEntry {
  description?: string;
  request?: Json;
  response?: Json;
}

export interface Field {
  name: string;
  /** Where it goes: a path, query or header parameter, or the body. */
  where: 'path' | 'query' | 'header' | 'body';
  type: string;
  required: boolean;
  deprecated: boolean;
  description: string;
  children: Field[];
}

export interface ErrorRow {
  code: string;
  status: number | null;
  fix: string;
}

export interface OpView {
  /** The anchor: the x-sdk method, prefixed with the sub-resource when there is one. */
  anchor: string;
  operationId: string;
  method: Method;
  path: string;
  title: string;
  idempotent: boolean;
  description: string;
  scopes: string[];
  /** `pb.passes.create`. */
  sdkCall: string;
  fields: Field[];
  /** The request body example, when the operation has one. */
  requestExample: Json | undefined;
  returns: { status: string; schema: string | null; example: Json | undefined } | null;
  errors: ErrorRow[];
  deprecated: boolean;
  /** The sub-resource heading this op sits under (`versions` for `passes.versions`). */
  sub: string | null;
  /** What the console island needs to run it. */
  run: RunOp;
}

export interface ConsoleOp {
  method: Method;
  path: string;
  title: string;
}

export interface ResourcePage {
  key: string;
  slug: string;
  label: string;
  group: string;
  ops: OpView[];
  consoleOnly: ConsoleOp[];
}

export interface ProtocolOp {
  method: Method;
  path: string;
  title: string;
  reason: string;
}

export interface WebhookEvent {
  type: string;
  summary: string;
}

export interface ChangeEntry {
  date: string;
  kind: 'Added' | 'Changed' | 'Fixed';
  text: string;
}

export interface ErrorEntry {
  code: string;
  status: number | null;
  title: string;
  when: string;
  fix: string;
  retryable: boolean | null;
  /** The operations that list the code, as `[page slug, anchor, title]`. */
  usedBy: { slug: string; anchor: string; title: string }[];
}

export interface Group {
  label: string;
  pages: ResourcePage[];
}

export interface Site {
  baseUrl: string;
  version: string;
  groups: Group[];
  pages: ResourcePage[];
  protocols: ProtocolOp[];
  webhookEvents: WebhookEvent[];
  changelog: ChangeEntry[];
  errors: ErrorEntry[];
  opCount: number;
}

/** A file the portal build writes under the asset directory. */
export interface OutFile {
  /** Under the asset directory, with a leading slash. */
  file: string;
  body: string;
  /** The path a visitor opens; pages only. */
  url?: string;
}
