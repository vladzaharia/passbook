import { describe, expect, it } from 'vitest';
import { ProbeDetectionsSchema } from '../contracts/connection-probe.ts';
import { detectResponse } from './detect.ts';
import { PROBE_LIMITS, prune } from './prune.ts';

/** The reviewer's probes: a small upstream answer must not become a huge probe answer. */
describe('bounded output', () => {
  it('a 500 KB key over 500 arrays prunes to a small document', () => {
    const inner: Record<string, number[]> = {};
    for (let i = 0; i < 500; i++) inner[`a${i}`] = Array(26).fill(0);
    const body = JSON.parse(JSON.stringify({ ['k'.repeat(480_000)]: inner }));
    const cut = prune(body);
    expect(JSON.stringify(cut).length).toBeLessThan(500_000);
    expect(cut.pruned.arrays).toEqual([]);
    expect(Object.keys(cut.value as object)[0]).toHaveLength(PROBE_LIMITS.string + 1);
  });

  it('keeps the notes whose pointers fit and drops the others', () => {
    const cut = prune({ short: Array(30).fill(1), ['x'.repeat(495)]: { deep: Array(30).fill(1) } });
    expect(cut.pruned.arrays.map((a) => a.pointer.length <= 500)).toEqual([true]);
    expect(cut.pruned.arrays[0]?.pointer).toBe('/short');
  });

  it('masks a whole string before it is cut, so no secret is split by the cut', () => {
    const secret = 'S'.repeat(20);
    const text = `${'a'.repeat(490)}${secret}${'b'.repeat(50)}`;
    const cut = prune({ t: text }, PROBE_LIMITS, (s) => s.replaceAll(secret, '***'));
    const out = (cut.value as { t: string }).t;
    expect(out).not.toContain('S');
    expect(out.startsWith(`${'a'.repeat(490)}***`)).toBe(true);
  });

  it('masks keys and numbers', () => {
    const cut = prune({ secretvalue: 1, n: 12345678 }, PROBE_LIMITS, (s) =>
      s.replaceAll('secretvalue', '***').replaceAll('12345678', '***'),
    );
    expect(cut.value).toEqual({ '***': 1, n: '***' });
  });

  it('a 200,000-level body neither throws nor goes past the depth limit', () => {
    const d = 200_000;
    const body = JSON.parse(`{"data":${'['.repeat(d)}${']'.repeat(d)}}`);
    const cut = prune(body);
    expect(cut.pruned.depthCut).toBe(true);
    expect(JSON.stringify(cut.value).length).toBeLessThan(1000);
    expect(() =>
      detectResponse({ body: cut.value, headers: {}, url: 'https://a.example/x' }),
    ).not.toThrow();
  });

  it('detections over a 400 KB key stay inside the contract and small', () => {
    const rec: Record<string, number> = {};
    for (let i = 0; i < 100; i++) rec[`f${i}`] = i;
    const body = prune(
      JSON.parse(JSON.stringify({ ['k'.repeat(400_000)]: { items: [rec, { ...rec, f0: 1000 }] } })),
    ).value;
    const found = detectResponse({ body, headers: {}, url: 'https://a.example/x' });
    expect(ProbeDetectionsSchema.safeParse(found).success).toBe(true);
    expect(JSON.stringify(found).length).toBeLessThan(200_000);
  });

  it('a pointer or path past the contract limits is left out, not cut', () => {
    const key = 'k'.repeat(490);
    const body = {
      [key]: {
        items: [
          { id: 'a', email: 'a@example.com' },
          { id: 'b', email: 'b@example.com' },
        ],
      },
    };
    const found = detectResponse({ body, headers: {}, url: 'https://a.example/x' });
    expect(ProbeDetectionsSchema.safeParse(found).success).toBe(true);
    for (const row of [...found.id, ...found.fields])
      expect(row.jsonPath.length).toBeLessThanOrEqual(600);
  });

  it('cuts evidence to 200 characters and drops candidates with long pointers', () => {
    const key = 'n'.repeat(300);
    const found = detectResponse({
      body: {
        data: [{ id: 'a' }],
        links: { [key]: { next: 'https://x.test/?p=2' } },
        [`${key}_cursor`]: 'c',
      },
      headers: {},
      url: 'https://a.example/x',
    });
    for (const c of found.pagination) expect(c.evidence.length).toBeLessThanOrEqual(200);
    expect(ProbeDetectionsSchema.safeParse(found).success).toBe(true);
  });
});
