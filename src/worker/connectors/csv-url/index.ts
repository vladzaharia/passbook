import { z } from 'zod';
import { CSV_LIMITS, CsvError, parseCsv } from '../../../shared/csv/parse.ts';
import { request } from '../lib/http.ts';
import {
  type ConnectorContext,
  type ConnectorDefinition,
  ConnectorError,
  type UpstreamRecord,
} from '../types.ts';

const PAGE = 200;
const HASH_CHARS = 16;
const SHOWN_COLUMNS = 8;

const config = z.object({
  url: z
    .url()
    .max(2000)
    .refine((v) => {
      if (!URL.canParse(v)) return true;
      const u = new URL(v);
      return u.protocol === 'https:' && !u.hash && !u.username && !u.password;
    }, 'Use an https link without a fragment or credentials.')
    .meta({
      'x-label': 'Sheet link',
      'x-help': 'A published CSV. In Google Sheets: File › Share › Publish to web › CSV.',
      'x-placeholder': 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv',
      'x-order': 1,
    }),
  idColumn: z.string().min(1).max(200).meta({
    'x-label': 'ID column',
    'x-help': 'The column that names each row. Rows with no ID, or a repeated one, are skipped.',
    'x-placeholder': 'Id',
    'x-order': 2,
  }),
});

type Config = z.infer<typeof config>;
type Ctx = ConnectorContext<Config, unknown>;

interface Sheet {
  header: string[];
  /** Rows with a usable, first-seen ID, in file order; blank cells are left out of the record. */
  rows: { ref: string; record: UpstreamRecord }[];
  hash: string;
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_CHARS);
}

/** One fetch and parse of the sheet. Bad files fail the run: too many rows is permanent, other faults retry. */
async function load(ctx: Ctx): Promise<Sheet> {
  const { url, idColumn } = ctx.connection.config;
  const res = await request(ctx as ConnectorContext<unknown, unknown>, url, {
    accept: 'text/csv, text/plain',
  });
  const body = res?.body;
  if (!body) throw new ConnectorError('UPSTREAM');
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(body, CSV_LIMITS);
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    if (error.code === 'IMPORT_TOO_MANY_ROWS' || error.code === 'IMPORT_TOO_MANY_COLUMNS')
      throw new ConnectorError('CONFIG', { permanent: true });
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  const idAt = parsed.header.indexOf(idColumn);
  if (idAt < 0) throw new ConnectorError('CONFIG', { permanent: true });
  const seen = new Set<string>();
  const rows: Sheet['rows'] = [];
  let noId = 0;
  let duplicate = 0;
  for (const { cells } of parsed.rows) {
    const ref = (cells[idAt] ?? '').trim();
    if (!ref) {
      noId++;
      continue;
    }
    if (seen.has(ref)) {
      duplicate++;
      continue;
    }
    seen.add(ref);
    const record: UpstreamRecord = {};
    parsed.header.forEach((h, i) => {
      const cell = cells[i];
      if (cell !== undefined && cell !== '') record[h] = cell;
    });
    rows.push({ ref, record });
  }
  if (noId > 0) ctx.log('csv_row_no_id', { code: 'CSV_ROW_NO_ID', rows: noId });
  if (duplicate > 0) ctx.log('csv_row_dup_id', { code: 'CSV_ROW_DUP_ID', rows: duplicate });
  return { header: parsed.header, rows, hash: await sha(body) };
}

/** `<offset>:<hash>`; a cursor of another file version, or a broken one, starts again at 0. */
function offsetOf(cursor: string | null, hash: string): number {
  const [offset, at] = (cursor ?? '').split(':');
  const n = Number(offset);
  return at === hash && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** A published CSV sheet, polled as a whole: the file is the source, a row is a record. */
const definition: ConnectorDefinition<Config, unknown> = {
  type: 'csv-url',
  version: 1,
  displayName: 'CSV sheet link',
  description: 'Keep passes in sync with a published CSV, such as a Google Sheet.',
  category: 'files',
  order: 20,
  capabilities: { poll: true },
  webhookReferenceMode: 'refs-only',
  configSchema: config,
  outputFields: {},
  urls: (c) => [c.url],
  // No egress pin: it sends no credentials, and published links redirect to export hosts; each hop is SSRF-checked.
  hasList: () => true,
  defaults: {
    intervalSeconds: 900,
    maxConcurrency: 1,
    requestsPerMinute: 6,
    timeoutMs: 15_000,
    maxResponseBytes: CSV_LIMITS.maxBytes,
    maxRedirects: 3,
  },

  async test(ctx) {
    const sheet = await load(ctx);
    const columns = sheet.header.slice(0, SHOWN_COLUMNS).join(', ');
    const more = sheet.header.length > SHOWN_COLUMNS ? ', …' : '';
    return { ok: true, detail: `${sheet.rows.length} rows. Columns: ${columns}${more}` };
  },

  async fetchRecord(ctx, ref) {
    const row = (await load(ctx)).rows.find((r) => r.ref === ref);
    return row ? { status: 'ok', record: row.record } : { status: 'not_found' };
  },

  async listChanges(ctx, cursor) {
    const sheet = await load(ctx);
    const from = offsetOf(cursor, sheet.hash);
    const page = sheet.rows.slice(from, from + PAGE);
    const next = from + page.length;
    return {
      changes: page.map((r) => ({ ref: r.ref, record: r.record })),
      cursor: `${next}:${sheet.hash}`,
      hasMore: next < sheet.rows.length,
    };
  },
};
export default definition;
