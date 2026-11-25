import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { evaluate } from '../../../passkit/template/expr.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Personalization } from '../../../passkit/types.ts';
import type { Pass } from '../passes/repo-map.ts';
import { partitionOf } from './google-compile.ts';
import { googleClassKeyDigest } from './google-ids.ts';

const template = (classKey: string, type = 'string') =>
  ({
    manifest: {
      inputs: { type: 'object', properties: { offer: { type } } },
      wallets: { schema: 1, google: { classKey } },
    },
  }) as unknown as ResolvedTemplate;
const pass = (personalization: object) => ({ personalization }) as unknown as Pass;

describe('the class partition of a pass', () => {
  it('keeps a key that reads default out of the default class', async () => {
    const named = await partitionOf(template('{{offer}}'), pass({ offer: 'default' }), 'offer');
    expect(named.classKey).toBe(await googleClassKeyDigest('default'));
    expect((await partitionOf(template('{{offer}}'), pass({}), 'offer')).classKey).toBeUndefined();
    expect(
      (await partitionOf(template('{{offer}}'), pass({ offer: '  ' }), 'offer')).classKey,
    ).toBeUndefined();
  });

  it('refuses an object key with a classified error', async () => {
    await expect(
      partitionOf(template('{{offer}}', 'object'), pass({ offer: { a: 1 } }), 'offer'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps events with a separator in their names apart in the shipped event keys', () => {
    for (const slug of ['starter-event-ticket', 'starter-multi-day-pass', 'starter-timed-ticket']) {
      const key = bakedTemplates.find((t) => t.slug === slug)?.manifest.wallets?.google?.classKey;
      if (typeof key !== 'string') throw new Error(`${slug} has no class key`);
      const of = (input: Personalization) => evaluate(key, { input, lookups: {} });
      expect(of({ eventName: 'a|b', startsAt: 'c' })).not.toBe(
        of({ eventName: 'a', startsAt: 'b|c' }),
      );
    }
  });
});
