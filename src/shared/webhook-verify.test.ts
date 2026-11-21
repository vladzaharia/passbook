import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../../sdk/typescript/src/index.ts';
import { buildWebhookVectors } from '../../tools/lib/webhook-vectors.ts';
import {
  firstFailure,
  runVectors,
  TOLERANCE_SECONDS,
  verifySteps,
  type WebhookVector,
} from './webhook-verify.ts';

const file = readFileSync(
  resolve(import.meta.dirname, '../../docs/api/webhook-vectors.json'),
  'utf8',
);
const { vectors } = JSON.parse(file) as { vectors: WebhookVector[] };

describe('docs/api/webhook-vectors.json', () => {
  it('is the server signing again today (run npm run gen when it moves)', async () => {
    expect(file).toBe(await buildWebhookVectors());
  });

  it('holds passing and failing cases for every step', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    const failing = new Set(
      vectors.flatMap((v) => (v.expect ? [`${v.expect.step}:${v.expect.cause}`] : [])),
    );
    expect([...failing].sort()).toEqual([
      'signature:mismatch',
      'signature:missing_signature',
      'signature:reserialized',
      'signature:secret_whitespace',
      'signature:whitespace',
      'timestamp:milliseconds',
      'timestamp:stale',
    ]);
    expect(vectors.filter((v) => v.expect === null).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Verify steps', () => {
  it.each(vectors.map((v) => [v.id, v] as const))(
    '%s: the first failure is the vector expect',
    async (_id, v) => {
      const steps = await verifySteps({ ...v });
      expect(firstFailure(steps)).toEqual(v.expect);
      // One sentence of fix per failing step, none for a passing one.
      for (const s of steps) {
        if (s.ok) expect(s.fix).toBeNull();
        else expect(s.fix).toMatch(/^[A-Z][^.!?]*[.!?]$/);
      }
      expect(steps.map((s) => s.id)).toEqual(['timestamp', 'string', 'signature']);
    },
  );

  it.each(vectors.map((v) => [v.id, v] as const))('%s: the SDK says the same', async (_id, v) => {
    const run = verifyWebhook(v.body, v.headers, v.secrets, { now: v.now });
    if (v.sdk === 'ok') await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toMatchObject({ reason: v.sdk });
  });

  it('agrees with every published vector', async () => {
    expect(await runVectors(vectors)).toEqual({ passed: vectors.length, total: vectors.length });
  });

  it('uses the 5 minute window of the server', async () => {
    const valid = vectors.find((v) => v.id === 'valid') as WebhookVector;
    const ts = Number(valid.headers['x-passbook-timestamp']);
    const at = (now: number) => verifySteps({ ...valid, now }).then((s) => s[0]?.ok);
    expect(TOLERANCE_SECONDS).toBe(300);
    expect(await at(ts + 300)).toBe(true);
    expect(await at(ts + 301)).toBe(false);
    expect(await at(ts - 301)).toBe(false);
  });

  it('never prints the secret', async () => {
    const wrong = vectors.find((v) => v.id === 'wrong-secret') as WebhookVector;
    const text = JSON.stringify(await verifySteps({ ...wrong }));
    for (const secret of wrong.secrets) expect(text).not.toContain(secret);
  });
});
