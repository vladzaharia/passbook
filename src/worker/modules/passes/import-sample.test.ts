import { describe, expect, it } from 'vitest';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { parseCsv } from '../../../shared/csv/parse.ts';
import { planOfSuggestion, suggestMapping } from '../../../shared/issuing/matcher.ts';
import { sampleCsv } from '../../../shared/issuing/sample.ts';
import { checkRows, isError, rowChecker } from './import-check.ts';

const templates = import.meta.glob<{ inputs: unknown; scan?: unknown }>(
  '../../../../templates/*/wallet.template.json',
  { eager: true, import: 'default' },
);

describe('the sample file of every shipped template', () => {
  for (const [path, template] of Object.entries(templates)) {
    const name = path.split('/').at(-2) ?? path;
    it(`${name} maps in full and checks with no errors`, () => {
      const manifest = template as unknown as TemplateManifest;
      const parsed = parseCsv(sampleCsv(template.inputs).replace(/^﻿/, ''));
      const suggestion = suggestMapping(
        template.inputs,
        parsed.header,
        parsed.rows.map((r) => r.cells),
        { idInput: manifest.scan?.lookup?.input },
      );
      expect(suggestion.unused).toEqual([]);
      const plan = { ...planOfSuggestion(suggestion), keepManual: false, save: false };
      const rc = { manifest, plan, header: parsed.header, zoneKeys: new Set<string>() };
      const [row] = checkRows(parsed.rows, rc);
      const full = row?.input ? rowChecker(rc)(2, applyDefaults(manifest, row.input), 'full') : [];
      const errors = [...(row?.problems ?? []), ...full].filter(isError);
      expect(errors.map((e) => `${e.field}: ${e.message}`)).toEqual([]);
    });
  }
});
