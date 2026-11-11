import { describe, it } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { app, env, ORIGIN, orgId, passId, recordedAction, template } from './repo-scans-split-test-fixtures.ts';

describe('dbg', () => {
  it('x', async () => {
    const scanner = await makeScanner(
      (await import('./repo-scans-split-test-fixtures.ts')).f,
      { orgId, templateIds: [template.resolved.id] },
    );
    const row = await recordedAction(scanner, passId);
    const rows = await env.DB.prepare(
      'SELECT id,state,outcome,actor_key,scanner_id,pass_id,event_id,org_id,mode,template_id FROM scans',
    ).all();
    console.log('DBGROWS', JSON.stringify(rows.results), scanner.id, row.id);
    const res = await app.request(`${ORIGIN}/api/v1/scan/scans`, { headers: scanner.headers }, env);
    console.log('DBGRES', await res.text());
  });
});
