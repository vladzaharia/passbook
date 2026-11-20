import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../test/helpers/index.ts';
import { resetBakedSync, syncBakedTemplates } from '../modules/templates/sync.ts';
import { all } from './db.ts';
import { createServiceContext } from './service-context.ts';

const sources = import.meta.glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Every path that inserts an org, by file. Each must write the entitlements row in the same batch
// (`addOrgEntitlements`); a new path fails this list until it does.
const ORG_INSERTS = [
  '../modules/orgs/repo-org-writes.ts', // platform create (preset chosen, default standard)
  '../modules/templates/repo-sync-writes.ts', // baked sync (legacy)
];

describe('every org-insert path writes an entitlements row', () => {
  it('enumerates the paths and each calls addOrgEntitlements', () => {
    const insert = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+orgs\b|insertSelect\(\s*['"]orgs['"]/i;
    const found = Object.entries(sources)
      .filter(([file]) => !/\.test\.tsx?$|test-fixtures|\/test-kit\.ts$/.test(file))
      .filter(([, text]) => insert.test(text))
      .map(([file]) => file)
      .sort();
    expect(found).toEqual([...ORG_INSERTS].sort());
    for (const file of ORG_INSERTS) expect(sources[file], file).toContain('addOrgEntitlements(');
  });

  it('baked sync gives the orgs it creates a legacy row', async () => {
    resetBakedSync();
    await syncBakedTemplates(createServiceContext(await makeEnv()));
    const rows = await all<{ slug: string; preset: string | null }>(
      env.DB,
      'SELECT o.slug, e.preset FROM orgs o LEFT JOIN org_entitlements e ON e.org_id = o.id WHERE o.id IN (SELECT org_id FROM templates WHERE origin = ?)',
      ['baked'],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.preset, r.slug).toBe('legacy');
  });
});
