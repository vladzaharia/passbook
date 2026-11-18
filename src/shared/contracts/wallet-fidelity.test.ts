import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../passkit/template/baked-fixtures.ts';
import { fidelityReport } from '../../passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '../../passkit/wallets/samsung/index.ts';
import { NOW, viewOf } from '../../passkit/wallets/view-fixtures.ts';
import { FidelityReportSchema } from './wallet-fidelity.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

describe('FidelityReportSchema', () => {
  it('parses the report of every baked template for both targets', async () => {
    for (const slug of bakedSlugs()) {
      const view = await viewOf(slug, {
        ctx: { assetUrl: (n: string) => `https://img.example/${n}` },
      });
      for (const [target, compiler] of [
        ['google', googleCompiler],
        ['samsung', samsungCompiler],
      ] as const) {
        const report = fidelityReport({ target, compiler, views: [view], now: NOW });
        expect(FidelityReportSchema.parse(report), `${slug} ${target}`).toEqual(report);
      }
    }
  }, 120_000);

  it('refuses an unknown capability', () => {
    const bad = {
      schema: 1,
      target: 'google',
      type: 'generic',
      compilerRevision: 1,
      status: { kind: 'ready' },
      items: [
        {
          capability: 'nope',
          path: '',
          support: 'text',
          severity: 'difference',
          chosen: false,
          message: 'x',
        },
      ],
    };
    expect(FidelityReportSchema.safeParse(bad).success).toBe(false);
  });
});
