import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Logger } from '../../platform/log.ts';
import { checkRows, rowChecker } from './import-check.ts';
import { planRows } from './import-match.ts';
import type { ImportPlan } from './import-plan.ts';
import type { ExistingPass } from './repo-import-lookup.ts';

const props: Record<string, unknown> = { name: { type: 'string', minLength: 1 } };
for (let i = 1; i <= 19; i++) props[`f${i}`] = { type: 'string' };
const manifest = {
  schema: 1,
  name: 'T',
  inputs: { type: 'object', required: ['name'], properties: props },
  bindings: [],
  display: { title: '{{name}}' },
} as unknown as TemplateManifest;

const log = { warn: () => undefined } as unknown as Logger;

/** A D1 stand-in that answers the external-id lookup with the 2,000 passes. */
function fakeDb(passes: ExistingPass[]): D1Database {
  return {
    prepare: () => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({
          results: passes.filter((p) => params.includes(p.external_id)),
        }),
      }),
    }),
  } as unknown as D1Database;
}

describe('planRows', () => {
  it('plans 2,000 matched updates of 20 inputs in under 2 seconds', () => {
    const header = ['Id', 'Name', ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`)];
    const mapping: ImportPlan['mapping'] = { name: { from: '/Name' } };
    for (let i = 1; i <= 19; i++) mapping[`f${i}`] = { from: `/F${i}` };
    const plan: ImportPlan = {
      mapping,
      holderEmail: null,
      externalId: { from: '/Id' },
      match: 'externalId',
      keepManual: false,
      save: false,
    };
    const existing: ExistingPass[] = [];
    const rows = Array.from({ length: 2000 }, (_, r) => {
      existing.push({
        id: `p${r}`,
        template_id: 't',
        external_id: `E${r}`,
        holder_email: null,
        connection_id: null,
        version: 1,
        status: 'active',
        personalization: JSON.stringify({ name: 'Old', f1: 'old' }),
        field_sources: JSON.stringify({ f1: 'manual' }),
      });
      return {
        row: r + 2,
        cells: [`E${r}`, `Name ${r}`, ...header.slice(2).map((_, i) => `v${r}-${i}`)],
      };
    });
    const rc = { manifest, plan, header, zoneKeys: new Set<string>() };
    const full = rowChecker(rc);
    const t0 = performance.now();
    return planRows(
      fakeDb(existing),
      { orgId: 'o', mode: 'live', templateId: 't' },
      plan,
      manifest,
      checkRows(rows, rc),
      (row, input) => full(row, input, 'full'),
      log,
    ).then((planned) => {
      const ms = performance.now() - t0;
      expect(planned.filter((p) => p.action === 'update')).toHaveLength(2000);
      expect(ms).toBeLessThan(2000);
    });
  });

  it('treats object inputs with the same keys in another order as equal', async () => {
    const plan: ImportPlan = {
      mapping: { name: { from: '/Name' } },
      holderEmail: null,
      externalId: { from: '/Id' },
      match: 'externalId',
      keepManual: false,
      save: false,
    };
    const m = {
      ...manifest,
      inputs: { type: 'object', properties: { name: { type: 'object' } } },
    } as unknown as TemplateManifest;
    const existing: ExistingPass = {
      id: 'p',
      template_id: 't',
      external_id: 'E',
      holder_email: null,
      connection_id: null,
      version: 1,
      status: 'active',
      personalization: JSON.stringify({ name: { a: 1, b: 2 } }),
      field_sources: '{}',
    };
    const [planned] = await planRows(
      fakeDb([existing]),
      { orgId: 'o', mode: 'live', templateId: 't' },
      plan,
      m,
      [
        {
          row: 2,
          externalId: 'E',
          holderEmail: null,
          input: { name: { b: 2, a: 1 } },
          problems: [],
        },
      ],
      () => [],
      log,
    );
    expect(planned?.action).toBe('unchanged');
  });
});
