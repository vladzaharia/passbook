import { z } from 'zod';
import {
  parseJsonBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignedRequest,
} from '../lib/hmac.ts';
import { isAllowedHeaderName } from '../lib/http.ts';
import { getPointer, isPointer } from '../lib/pointer.ts';
import { type ConnectorDefinition, ConnectorError, type UpstreamRecord } from '../types.ts';

const MAX_RECORDS = 100;
const pointer = z.string().max(200).refine(isPointer, 'Not a JSON pointer.');

const config = z.object({
  recordsPointer: pointer
    .default('/records')
    .meta({ 'x-label': 'Records', 'x-help': 'Where the list of records sits in the body.' }),
  refPointer: pointer
    .default('/ref')
    .meta({ 'x-label': 'Record ID', 'x-help': 'Inside each item.' }),
  recordPointer: pointer
    .default('/record')
    .meta({ 'x-label': 'Record', 'x-help': 'The record inside each item.' }),
  deletedPointer: pointer
    .default('/deleted')
    .meta({ 'x-label': 'Deleted flag', 'x-help': 'True removes the record.' }),
  eventIdPointer: pointer.default('/id').meta({
    'x-label': 'Event ID',
    'x-help': 'Repeated events are ignored.',
    'x-group': 'Advanced',
  }),
  signatureHeader: z
    .string()
    .refine(isAllowedHeaderName)
    .default(SIGNATURE_HEADER)
    .meta({ 'x-label': 'Signature header', 'x-group': 'Advanced' }),
  timestampHeader: z
    .string()
    .refine(isAllowedHeaderName)
    .default(TIMESTAMP_HEADER)
    .meta({ 'x-label': 'Timestamp header', 'x-group': 'Advanced' }),
});

/** Records arrive in the signed webhook body; nothing is fetched. */
const definition: ConnectorDefinition<z.infer<typeof config>, undefined> = {
  type: 'webhook-push',
  version: 1,
  displayName: 'Webhook push',
  description: 'Your system sends signed records.',
  capabilities: { webhook: true },
  webhookReferenceMode: 'embedded-required',
  configSchema: config,
  outputFields: {},
  defaults: { intervalSeconds: 3600, maxConcurrency: 1, requestsPerMinute: 60, timeoutMs: 15_000 },

  async test(ctx) {
    if (!ctx.webhookSecret) throw new ConnectorError('CONFIG', { permanent: true });
    return { ok: true, detail: 'Waiting for signed webhooks.' };
  },

  async fetchRecord() {
    return { status: 'not_modified' };
  },

  async verifyWebhook(ctx, req) {
    const c = ctx.connection.config;
    const { body, signature } = await verifySignedRequest(req, {
      secret: ctx.webhookSecret,
      now: ctx.now(),
      signatureHeader: c.signatureHeader,
      timestampHeader: c.timestampHeader,
    });
    const payload = parseJsonBody(body);
    const items = getPointer(payload, c.recordsPointer);
    if (!Array.isArray(items) || items.length > MAX_RECORDS) {
      throw new ConnectorError('INVALID_PAYLOAD');
    }
    const records: Record<string, UpstreamRecord> = {};
    const deleted: string[] = [];
    const refs: string[] = [];
    for (const item of items) {
      const rawRef = getPointer(item, c.refPointer);
      const ref = typeof rawRef === 'number' ? String(rawRef) : rawRef;
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
        throw new ConnectorError('INVALID_PAYLOAD');
      }
      if (refs.includes(ref)) continue;
      refs.push(ref);
      if (getPointer(item, c.deletedPointer) === true) {
        deleted.push(ref);
        continue;
      }
      const record = getPointer(item, c.recordPointer);
      if (record === null || typeof record !== 'object' || Array.isArray(record) || !record) {
        throw new ConnectorError('INVALID_PAYLOAD');
      }
      records[ref] = record;
    }
    const rawId = getPointer(payload, c.eventIdPointer);
    const eventId =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).slice(0, 200)
        : `sig:${signature.slice(0, 32)}`;
    return { eventId, refs, records, deleted };
  },
};
export default definition;
