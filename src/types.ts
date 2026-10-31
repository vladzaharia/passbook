export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Personalization = Record<string, string | number | boolean>;
export interface InputField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  maxLength?: number;
  format?: 'https-url' | 'date-time';
  enum?: (string | number | boolean)[];
  pattern?: string;
  fieldKeys?: string[];
  paths?: string[];
}
export interface PassTemplate {
  id: string;
  version: number;
  name: string;
  signingIdentity: string;
  apnsBinding: string;
  pass: Record<string, Json>;
  assets: Record<string, string>;
  inputs: Record<string, InputField>;
  customize?: (pass: Record<string,Json>, input: Personalization) => void;
}
export interface SigningIdentity {
  certificate: string;
  privateKey: string;
  intermediate: string;
}
export interface EmailPayload {
  from: string | { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: { content: string; filename: string; type: string; disposition: 'attachment' | 'inline'; contentId?: string }[];
}
export interface Env {
  [binding: string]: unknown;
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  JOBS: Queue<Job>;
  APNS?: Fetcher;
  EMAIL?: { send(message: EmailPayload): Promise<{ messageId: string }> };
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string;
  EMAIL_FROM?: string;
  MEMBERSHIP_API_BASE_URL?: string;
  MEMBERSHIP_API_TOKEN?: string;
}
export type Job = { kind: 'outbox'; id: string } | { kind: 'sync'; serial: string };
export interface PassRow {
  serial: string;
  template_id: string;
  template_version: number;
  pass_type: string;
  personalization: string;
  authentication_token: string;
  download_token: string;
  object_key: string;
  revision: number;
  version: number;
  modified: number;
  modified_collision: number;
  source_id: string | null;
  source_reference: string | null;
  source_version: number;
  next_sync: number;
  sync_error: string | null;
}
export interface OutboxRow {
  id: string;
  kind: 'push' | 'email';
  serial: string;
  payload: string;
  state: 'pending' | 'processing' | 'sent' | 'failed';
  attempts: number;
  available_at: number;
  lease: string | null;
}
