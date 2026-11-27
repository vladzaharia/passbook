import { describe, expect, it } from 'vitest';
import {
  SETUP_SEND_TROUBLE_KEYS,
  SETUP_TROUBLE_KEYS,
  type SetupGuide,
  SetupGuideSchema,
} from '../../../../shared/contracts/connection-setup.ts';
import { outboundSetup } from '../../../modules/webhooks/setup-guide.ts';
import { RECIPE_INFOS, RECIPES, SETUP_GUIDES } from './index.ts';
import unverified from './UNVERIFIED.md?raw';

/**
 * A guide's content pinned to its version. Changing a step moves the hash: the test then asks for a new
 * `version` and a new pin, so the change shows in review.
 */
const PINS: Record<string, { version: string; hash: string }> = {
  custom: { version: '2026-11-28', hash: 'd404d7b563a0c490' },
  'shopify-orders': { version: '2026-11-28', hash: '879575630397542f' },
  'shopify-customers': { version: '2026-11-28', hash: 'a949924ea959ff77' },
  'stripe-subscriptions': { version: '2026-11-26', hash: '925695bb1e1880b0' },
  'stripe-payments': { version: '2026-11-26', hash: '749b4fbfff2a5136' },
  'calcom-bookings': { version: '2026-11-26', hash: '6a8ba432d4c963fd' },
  'woocommerce-orders': { version: '2026-11-26', hash: '8d488a9a7090af45' },
  'tickettailor-tickets': { version: '2026-11-26', hash: '3d21cf7fc9450d1f' },
  outbound: { version: '2026-11-27', hash: 'd36a3d3bcfad314f' },
};

async function contentHash(guide: SetupGuide): Promise<string> {
  const { version: _v, checkedAt: _c, ...content } = guide;
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

const recipes = Object.values(RECIPES);
const everyGuide: SetupGuide[] = [...Object.values(SETUP_GUIDES), outboundSetup];

describe('recipe setup guides', () => {
  it('has a guide for every recipe, and the guide names its recipe', () => {
    for (const r of recipes) expect(r.setup.recipe).toBe(r.id);
    expect(Object.keys(SETUP_GUIDES).sort()).toEqual([...Object.keys(RECIPES), 'custom'].sort());
    for (const [id, guide] of Object.entries(SETUP_GUIDES)) expect(guide.recipe).toBe(id);
    expect(outboundSetup.recipe).toBe('outbound');
  });

  it.each(recipes)('$id: guide topics are the recipe topics, nothing more', (r) => {
    const topics = r.setup.subscriptions.topics.map((t) => t.id);
    expect([...topics].sort()).toEqual([...r.topics].sort());
    expect(new Set(topics).size).toBe(topics.length);
    expect(r.setup.subscriptions.topics.some((t) => t.required)).toBe(true);
  });

  it.each(recipes)('$id: the secret origin matches the recipe', (r) => {
    expect(r.setup.secret.origin).toBe(r.secretOrigin);
    expect(r.pasteSecret).toBe(r.secretOrigin === 'provider');
    expect(r.setup.secret.whereStep === null).toBe(r.secretOrigin === 'passbook');
  });

  it('shares one secret across a Shopify store, and nothing else', () => {
    for (const r of recipes) {
      expect(r.secretScope).toBe(r.id.startsWith('shopify-') ? 'account' : 'connection');
    }
  });

  it.each(everyGuide.map((g) => [g.recipe, g] as const))('%s: is well formed', (_id, g) => {
    expect(SetupGuideSchema.safeParse(g).success).toBe(true);
    const ids = g.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    if (g.secret.whereStep !== null) {
      const where = g.steps.find((s) => s.id === g.secret.whereStep);
      expect(where?.side).toBe('provider');
    }
    const parts = g.steps.flatMap((s) => s.parts);
    expect(parts.some((p) => p.t === 'topics')).toBe(g.subscriptions.topics.length > 0);
    for (const p of parts) {
      if (p.t !== 'field' || !p.copy) continue;
      if (p.copy === 'secret') expect(g.secret.origin).toBe('passbook');
      if (p.copy === 'signatureHeader' || p.copy === 'timestampHeader') {
        expect(g.recipe).toBe('custom');
      }
      if (p.copy === 'endpointUrl') expect(g.direction).toBe('inbound');
    }
  });

  it('keys troubleshooting by what the ledger or a test send reports', () => {
    for (const g of Object.values(SETUP_GUIDES)) {
      for (const key of Object.keys(g.troubleshooting)) {
        expect(SETUP_TROUBLE_KEYS as readonly string[]).toContain(key);
      }
      expect(g.troubleshooting.none).toBeTruthy();
    }
    expect(Object.keys(outboundSetup.troubleshooting).sort()).toEqual(
      [...SETUP_SEND_TROUBLE_KEYS].sort(),
    );
  });

  it('lists the picker line, secret origin and guide version on each recipe', () => {
    for (const info of RECIPE_INFOS) {
      const r = RECIPES[info.id as keyof typeof RECIPES];
      expect(info.line).toBe(r.line);
      expect(info.secretOrigin).toBe(r.secretOrigin);
      expect(info.setupVersion).toBe(r.setup.version);
    }
  });

  it('never carries a secret', () => {
    for (const g of everyGuide) expect(JSON.stringify(g)).not.toMatch(/whsec_[A-Za-z0-9]{8}/);
  });

  it('pins every guide to its version', async () => {
    const problems: string[] = [];
    for (const g of everyGuide) {
      const now = { version: g.version, hash: await contentHash(g) };
      const pin = PINS[g.recipe];
      if (pin?.hash === now.hash && pin.version === now.version) continue;
      problems.push(
        pin?.hash === now.hash
          ? `${g.recipe}: the version moved with no change to the steps.`
          : `${g.recipe}: ${pin?.version === now.version ? 'the steps changed; bump its version, then ' : ''}set its pin to ${JSON.stringify(now)}.`,
      );
    }
    expect(problems).toEqual([]);
  });
});

describe('recipes/UNVERIFIED.md', () => {
  const listed = new Set([...unverified.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1] ?? ''));
  const flagged = new Set<string>();
  for (const g of everyGuide) {
    for (const s of g.steps) if (!s.verified) flagged.add(`${g.recipe}#${s.id}`);
    for (const t of g.subscriptions.topics)
      if (!t.verified) flagged.add(`${g.recipe}#topic:${t.id}`);
  }

  it('lists every part flagged verified: false', () => {
    expect([...flagged].filter((k) => !listed.has(k))).toEqual([]);
  });

  it('lists nothing that is no longer flagged', () => {
    expect([...listed].filter((k) => !flagged.has(k))).toEqual([]);
  });
});
