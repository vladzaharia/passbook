import { type ConnectorDefinition, ConnectorError, declareCapabilities } from '../types.ts';
import { type Config, config } from './config.ts';
import { list } from './list.ts';

const SHOWN_COLUMNS = 8;

/** Rows from files an admin uploads. Everything is read through `ctx.files`; there is no network. */
const definition: ConnectorDefinition<Config, unknown> = {
  type: 'file-upload',
  version: 1,
  displayName: 'File upload',
  description: 'Keep passes in sync with a CSV, Excel or JSON file you upload.',
  category: 'files',
  order: 10,
  capabilities: declareCapabilities({ read: { upload: true }, auth: 'none' }),
  webhookReferenceMode: 'refs-only',
  configSchema: config,
  outputFields: {},
  fixedConfig: ['idColumn'],
  egress: () => [],
  hasList: () => true,
  defaults: {
    intervalSeconds: 3600,
    maxConcurrency: 1,
    // No network: removals are checked one by one against the files, so do not pace them.
    requestsPerMinute: 6000,
    timeoutMs: 15_000,
  },

  async test(ctx) {
    const file = await (ctx.files ?? failConfig()).current();
    if (!file) return failConfig();
    const columns = file.columns.slice(0, SHOWN_COLUMNS).join(', ');
    const more = file.columns.length > SHOWN_COLUMNS ? ', …' : '';
    return { ok: true, detail: `${file.rows} rows. Columns: ${columns}${more}` };
  },

  async fetchRecord(ctx, ref) {
    const files = ctx.files ?? failConfig();
    const current = await files.current();
    if (!current) return failConfig();
    const record = await files.find(current.id, ref);
    return record ? { status: 'ok', record } : { status: 'not_found' };
  },

  async listChanges(ctx, cursor) {
    return list(ctx.files ?? failConfig(), cursor, ctx.log);
  },
};

function failConfig(): never {
  throw new ConnectorError('CONFIG', { permanent: true });
}

export default definition;
