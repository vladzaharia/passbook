import { describe, expect, it } from 'vitest';
import type { PassJson } from '../types.ts';
import { validatePass } from '../validate.ts';
import { FIXTURES, NFC_ID } from './fixtures.ts';
import type { ValidatableAsset } from './validate-images.ts';
import type { PackageContents } from './validate-package.ts';

// biome-ignore lint/suspicious/noExplicitAny: mutators edit arbitrary pass keys
export type Loose = any;
// biome-ignore lint/suspicious/noConfusingVoidType: most mutators return nothing
export type Mutator = (
  pass: Loose,
  assets: ValidatableAsset[],
) => ValidatableAsset[] | undefined | void;

export function run(
  fixture: string,
  mutate: Mutator,
  options: PackageContents & { nfc?: boolean } = {},
) {
  const f = FIXTURES.find((x) => x.name === fixture);
  if (!f) throw new Error(fixture);
  const pass = structuredClone(f.pass) as Loose;
  const assets = mutate(pass, [...f.assets]) || f.assets;
  const identity = options.nfc || f.identity.nfcEnabled ? NFC_ID : f.identity;
  return validatePass(pass as PassJson, assets, identity, options);
}
export const has = (r: ReturnType<typeof run>, severity: 'error' | 'warning', code: string) =>
  r.issues.some((i) => i.severity === severity && i.code === code);

export interface Rule {
  rule: string;
  fixture: string;
  mutate: Mutator;
  severity: 'error' | 'warning';
  code: string;
  options?: PackageContents & { nfc?: boolean };
}

export const poster = 'posterGeneric with generic fallback';
export const pet = 'poster event ticket';
export const sbp = 'semantic boarding pass';

export function checkRules(title: string, rules: Rule[]): void {
  describe(title, () => {
    it.each(rules.map((r) => [r.rule, r] as const))('flags %s', (_name, r) => {
      const report = run(r.fixture, r.mutate, r.options);
      expect(has(report, r.severity, r.code), JSON.stringify(report.issues, null, 1)).toBe(true);
      if (r.severity === 'error') expect(report.ok).toBe(false);
    });
  });
}
