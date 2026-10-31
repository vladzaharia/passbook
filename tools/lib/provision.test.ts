import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc.ts';
import {
  buildSteps,
  findDatabaseId,
  LEGACY_SECRETS,
  namesFrom,
  provision,
  type WranglerNames,
} from './provision.ts';

const names: WranglerNames = {
  worker: 'wallet',
  database: 'wallet-platform',
  queues: ['wallet-jobs', 'wallet-jobs-dlq'],
  bucket: 'wallet-passes',
};
const ID = '11111111-2222-3333-4444-555555555555';
const CONFIG = `{
  // comment kept
  "d1_databases": [{ "binding": "DB", "database_name": "wallet-platform", "database_id": "0000" }],
}`;

describe('provision plan', () => {
  it('reads names from wrangler config', () => {
    expect(
      namesFrom({
        name: 'wallet',
        d1_databases: [{ database_name: 'wallet-platform' }],
        queues: { producers: [{ queue: 'a' }, { queue: 'b' }] },
        r2_buckets: [{ bucket_name: 'wallet-passes' }],
      }),
    ).toEqual({ ...names, queues: ['a', 'b'] });
  });

  it('covers database, queues, bucket, lifecycle and the legacy secrets', () => {
    const commands = buildSteps(names).map((s) => s.args.join(' '));
    expect(commands).toContain('d1 create wallet-platform');
    expect(commands).toContain('queues create wallet-jobs-dlq');
    expect(commands).toContain('r2 bucket create wallet-passes');
    expect(commands).toContain(
      'r2 bucket lifecycle add wallet-passes expire-uploads uploads/ --expire-days 1',
    );
    for (const secret of LEGACY_SECRETS)
      expect(commands).toContain(`secret delete ${secret} --name wallet`);
  });

  it('finds the database id', () => {
    expect(
      findDatabaseId(JSON.stringify([{ name: 'wallet-platform', uuid: ID }]), 'wallet-platform'),
    ).toBe(ID);
    expect(findDatabaseId('[]', 'wallet-platform')).toBeNull();
  });
});

describe('provision run', () => {
  function harness(existing: { d1: boolean; secrets: string[] }) {
    const calls: string[] = [];
    let config = CONFIG;
    let d1 = existing.d1;
    const run = (args: string[]) => {
      const line = args.join(' ');
      calls.push(line);
      if (line === 'd1 list --json')
        return JSON.stringify(d1 ? [{ name: 'wallet-platform', uuid: ID }] : []);
      if (line === 'd1 create wallet-platform') d1 = true;
      if (line.startsWith('secret list'))
        return JSON.stringify(existing.secrets.map((name) => ({ name, type: 'secret_text' })));
      return '';
    };
    const go = () =>
      provision({
        names,
        run,
        readConfig: () => config,
        writeConfig: (t) => (config = t),
        log: () => {},
      });
    return { calls, go, config: () => config };
  }

  it('creates what is missing, deletes only present legacy secrets and writes the id', () => {
    const h = harness({ d1: false, secrets: ['ADMIN_TOKEN', 'KEK_V1'] });
    const result = h.go();
    expect(result.databaseId).toBe(ID);
    expect(h.calls).toContain('d1 create wallet-platform');
    expect(h.calls).toContain('secret delete ADMIN_TOKEN --name wallet');
    expect(h.calls).not.toContain('secret delete SIGNER_HENRYS_CERTIFICATE --name wallet');
    expect(h.calls).not.toContain('secret delete KEK_V1 --name wallet');
    expect(h.config()).toContain('// comment kept');
    expect(
      parseJsonc<{ d1_databases: { database_id: string }[] }>(h.config()).d1_databases[0]
        ?.database_id,
    ).toBe(ID);
  });

  it('skips an existing database', () => {
    const h = harness({ d1: true, secrets: [] });
    h.go();
    expect(h.calls).not.toContain('d1 create wallet-platform');
  });
});
