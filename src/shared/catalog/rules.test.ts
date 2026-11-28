import { describe, expect, it } from 'vitest';
import {
  autoUpOffered,
  checkCatalog,
  defaultOverageCapMinor,
  nextPlan,
  RULE_IDS,
  type RuleId,
} from './rules.ts';
import type { Catalog, CatalogPlan, PlanId } from './types.ts';
import { CATALOG_V1 } from './v1.ts';

const plan = (c: Catalog, id: PlanId): CatalogPlan => {
  const p = c.plans.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
};
const addon = (c: Catalog, id: string) => {
  const a = c.addons.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a;
};
const row = (c: Catalog, label: string) => {
  const r = c.rows.find((x) => x.label === label);
  if (!r) throw new Error(label);
  return r;
};
const broken = (mutate: (c: Catalog) => void): RuleId[] => {
  const c = structuredClone(CATALOG_V1) as Catalog;
  mutate(c);
  return [...new Set(checkCatalog(c).map((v) => v.rule))];
};

describe('catalog rules', () => {
  it('v1 passes every rule', () => {
    expect(checkCatalog(CATALOG_V1)).toEqual([]);
  });

  const fixtures: Record<RuleId, (c: Catalog) => void> = {
    'extras-never-rise': (c) => {
      const m = plan(c, 'business').meters?.live_passes;
      if (m?.kind === 'blocks') m.blockMinor = 200;
    },
    'no-footer-removal-on-admit-one': (c) => {
      addon(c, 'remove-footer').plans.starter = { priceMinor: 2900 };
    },
    'packs-on-paid-plans': (c) => {
      delete addon(c, 'zones-5').plans.starter;
    },
    'addon-below-next-step': (c) => {
      const a = addon(c, 'audit-7y').plans;
      a.business = { priceMinor: 50000 };
    },
    'annual-ten-times': (c) => {
      plan(c, 'standard').annualMinor = 120000;
    },
    'features-add-up': (c) => {
      row(c, 'Desk console').cells.business = { kind: 'no' };
    },
    'auto-up-plans': (c) => {
      c.switches.autoUp = { ...c.switches.autoUp, plans: ['starter', 'premium'] };
    },
  };

  it('has one fixture per rule', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...RULE_IDS].sort());
  });

  for (const id of RULE_IDS) {
    it(`fails ${id} on its fixture only`, () => {
      expect(broken(fixtures[id])).toEqual([id]);
    });
  }

  it('excludes developer seats from the pack rule on Admit One only', () => {
    expect(broken((c) => delete addon(c, 'developer-seat').plans.business)).toEqual([
      'packs-on-paid-plans',
    ]);
  });

  it('catches a smaller meter allowance up the ladder', () => {
    const fewer = (c: Catalog) => {
      const m = plan(c, 'business').meters?.passes_issued;
      if (m?.kind === 'blocks') m.included = 10000;
    };
    expect(broken(fewer)).toEqual(['features-add-up']);
  });

  it('catches trial, enterprise and unbilled plans in autoUp', () => {
    for (const id of ['trial', 'enterprise', 'legacy', 'developer'] as const) {
      expect(broken((c) => (c.switches.autoUp.plans = [id]))).toEqual(['auto-up-plans']);
    }
  });
});

describe('catalog helpers', () => {
  it('finds the next self-serve plan', () => {
    expect(nextPlan(CATALOG_V1, 'starter')?.id).toBe('standard');
    expect(nextPlan(CATALOG_V1, 'business')?.id).toBe('premium');
    expect(nextPlan(CATALOG_V1, 'premium')).toBeNull();
    expect(nextPlan(CATALOG_V1, 'legacy')).toBeNull();
  });

  it("defaults the overage cap to the next plan's price, All Access its own", () => {
    expect(defaultOverageCapMinor(CATALOG_V1, 'starter')).toBe(14900);
    expect(defaultOverageCapMinor(CATALOG_V1, 'standard')).toBe(34900);
    expect(defaultOverageCapMinor(CATALOG_V1, 'business')).toBe(84900);
    expect(defaultOverageCapMinor(CATALOG_V1, 'premium')).toBe(84900);
    expect(defaultOverageCapMinor(CATALOG_V1, 'trial')).toBeNull();
    expect(defaultOverageCapMinor(CATALOG_V1, 'enterprise')).toBeNull();
  });

  it('offers autoUp on Admit One, Season Pass and Backstage while the switch is on', () => {
    const on = (c: Catalog) => c.plans.filter((p) => autoUpOffered(c, p.id)).map((p) => p.id);
    expect(on(CATALOG_V1)).toEqual(['starter', 'standard', 'business']);
    const off = structuredClone(CATALOG_V1) as Catalog;
    off.switches.autoUp.on = false;
    expect(on(off)).toEqual([]);
  });
});
