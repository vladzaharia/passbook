import { it } from 'vitest';
import { kit, snippetWorld } from './snippet-world.ts';
it('dbg', async () => {
  const k = await kit();
  const w = await snippetWorld(k);
  const rows = await k.env.DB.prepare("SELECT id, org_id, status, blueprint, active_version FROM templates WHERE id = ?").bind(w.templateId).all();
  console.log('ROWS', JSON.stringify(rows.results));
  void w;
});
