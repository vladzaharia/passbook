import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every read that joins the instances table to a pass by `credential_generation` is listed with how it
 * names one slot. A new site fails this test until it is added with its resolution.
 */
const SLOT_READS: Record<string, string> = {
  'repo-accounts.ts':
    'retirement target: pinned by instance id, and now by channel_epoch (successor shares pass, release, generation)',
  'repo-instance.ts': 'getInstanceByPass: ORDER BY channel_epoch DESC LIMIT 1',
  'repo-offers.ts':
    'current_instance proof reads all rows of the generation (each must hold a valid op); offer join is by instance id',
  'repo-sync-queue.ts': 'by instance id; only epoch 1 placeholders are blank',
  'repo-instance-mutations.ts':
    'insert guard names epochs below the new one; operation insert is by instance id',
  'repo-callbacks-tombstone-retirement.ts': 'by instance id and desired operation',
  'repo-callbacks.ts': 'by reference hash and instance id',
  'repo-google-callback.ts': 'by instance id; the binding carries the instance epoch',
  'repo-status.ts': 'latest epoch of the generation (MAX(channel_epoch) subselect)',
  'repo-instance-slot-sql.ts':
    'the insert guard: older epochs must be settled channel-off predecessors',
  'repo-instance-retirement-staging.ts':
    'by instance id; channel-off staging also by pass generation',
};

describe('wallet provider instance slot reads', () => {
  const dir = join(import.meta.dirname, '../src/worker/modules/wallet-providers');
  it('keeps the list of credential_generation joins closed', () => {
    const pattern =
      /(\bi|current_instance|actual|old|previous|prior|slot|pred)\.credential_generation\s*(=|!=|<|>|<=|>=)\s*(\?|p\.|pass\.|i\.|op\.)|(p|pass)\.credential_generation = i\.credential_generation/;
    const found = readdirSync(dir)
      .filter((name) => /^repo-.*\.ts$/.test(name) && !/test|fixtures/.test(name))
      .filter((name) => pattern.test(readFileSync(join(dir, name), 'utf8')))
      .sort();
    expect(found).toEqual(Object.keys(SLOT_READS).sort());
  });
});
