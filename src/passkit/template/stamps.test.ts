import { beforeAll, describe, expect, it } from 'vitest';
import { PassBuildError, planPass } from '../build.ts';
import { sha1Hex } from '../sign/index.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { PassField, PassJson, Personalization, TemplateManifest } from '../types.ts';
import { bakedBehaviors, freezeNow, loadBaked } from './baked-fixtures.ts';
import { checkExpr, evaluate, testCondition } from './expr.ts';
import { projectDisplay, validateManifest } from './manifest.ts';
import type { ResolvedTemplate, TemplateRegistry } from './registry.ts';
import { stampScopeFor, stampsIssues } from './stamps.ts';

const SLUG = 'starter-stamp-card';
let template: ResolvedTemplate;
let registry: TemplateRegistry;
beforeAll(async () => {
  freezeNow();
  await createFixtureIdentity();
  ({ template, registry } = await loadBaked(SLUG));
}, 120_000);

const server = {
  serial: 's',
  authToken: 'a'.repeat(32),
  webServiceURL: 'https://wallet.example/wallet',
  organizationName: 'Org',
  identity: FIXTURE_IDENTITY,
};
const plan = (input: Personalization, over: Partial<Parameters<typeof planPass>[0]> = {}) =>
  planPass({
    template,
    registry,
    input,
    server,
    signing: undefined as never,
    behaviors: bakedBehaviors,
    ...over,
  });
const sample = (stamps: number): Personalization => ({
  holder: 'Alex',
  cardNumber: 'C1',
  reward: 'Free coffee',
  stamps,
});
const header = (pass: PassJson): PassField =>
  (pass.storeCard as { headerFields: PassField[] }).headerFields.find(
    (f) => f.key === 'stamps',
  ) as PassField;
const stripOf = (p: ReturnType<typeof plan>, scale: 2 | 3) =>
  p.assets.find((a) => a.name === `strip@${scale}x.png`);

describe('pass.stamps scope', () => {
  const block = (goal: number) => ({ stamps: { input: 'n', goal } }) as unknown as TemplateManifest;
  it('reads goal, card, left, ready and extra in expressions', () => {
    const scope = {
      input: {},
      lookups: {},
      pass: { stamps: { goal: 10, card: 10, left: 0, ready: true, extra: 2 } },
    };
    expect(evaluate('{{pass.stamps.card}} of {{pass.stamps.goal}}', scope)).toBe('10 of 10');
    expect(evaluate('{{pass.stamps.extra}}', scope)).toBe(2);
    expect(checkExpr('{{pass.stamps.ready}}')).toBeNull();
  });
  it('reads pass paths in conditions', () => {
    const at = (n: number) => ({
      input: {},
      lookups: {},
      pass: { stamps: stampScopeFor({ ...block(10), inputs: {} } as never, { n })! },
    });
    const ready = { input: 'pass.stamps.ready', eq: true };
    expect(testCondition(ready, at(9))).toBe(false);
    expect(testCondition(ready, at(10))).toBe(true);
  });
  it('is absent without a block', () => {
    expect(stampScopeFor({} as TemplateManifest, { n: 3 })).toBeUndefined();
  });
  it('feeds the passes list', () => {
    const m = template.manifest;
    expect(projectDisplay(m, sample(5)).status).toBe('5 of 10');
    expect(projectDisplay(m, sample(12)).status).toBe('10 of 10');
  });
});

describe('Stamp card pass build', () => {
  it.each([
    [0, '0 of 10', 0],
    [7, '7 of 10', 7],
    [9, '9 of 10', 9],
    [10, 'Reward ready', 10],
    [12, 'Reward ready', 10],
    [19, 'Reward ready', 10],
  ])('at %i stamps the header reads %s and the strip draws %i', async (stamps, text, drawn) => {
    const p = plan(sample(stamps));
    expect(header(p.passJson).value).toBe(text);
    const strip = stripOf(p, 2);
    expect(strip?.source).toBe(`stamps/strips/${drawn}/strip@2x.png`);
    expect(strip).toMatchObject({ width: 750, height: 288 });
    expect(stripOf(p, 3)).toMatchObject({ width: 1125, height: 432 });
  });

  it('ships no art, no base strip and no other count', () => {
    const names = plan(sample(4)).assets.map((a) => a.name);
    expect(names.filter((n) => n.startsWith('stamps/'))).toEqual([]);
    expect(names.filter((n) => n.startsWith('strip'))).toEqual(['strip@2x.png', 'strip@3x.png']);
  });

  it('has the same content hash for the same count and a new one per count', async () => {
    const sha = async (n: number) =>
      await sha1Hex(new TextEncoder().encode(JSON.stringify(plan(sample(n)).assets)));
    expect(await sha(4)).toBe(await sha(4));
    expect(await sha(4)).not.toBe(await sha(5));
    // Stamps over the goal change nothing the holder sees.
    expect(await sha(10)).toBe(await sha(15));
  });

  it('lets a per-pass strip win', () => {
    const bytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 238, 0, 0, 1, 32,
    ]);
    const p = plan(sample(3), { assetOverrides: { 'strip@2x.png': { bytes } } });
    expect(stripOf(p, 2)?.source).toBeUndefined();
    expect(stripOf(p, 2)?.bytes).toBe(bytes);
  });

  it('fails TEMPLATE when no strip was drawn for the count', () => {
    const bare = { ...template, assets: template.assets.filter((a) => a.stamps !== 7) };
    expect(() => plan(sample(7), { template: bare })).toThrow(PassBuildError);
    try {
      plan(sample(7), { template: bare });
    } catch (e) {
      expect((e as PassBuildError).code).toBe('TEMPLATE');
      expect((e as PassBuildError).message).toBe('No strip for 7 stamps.');
    }
  });
});

/** Wallet alerts only when a field's value changes and that field carries a changeMessage. */
const alerts = (a: PassJson, b: PassJson) => {
  const f = header(b);
  return (
    f.changeMessage !== undefined && JSON.stringify(header(a).value) !== JSON.stringify(f.value)
  );
};

describe('reward notification', () => {
  const at = (n: number) => plan(sample(n)).passJson;
  it('alerts exactly once per card, at the goal', () => {
    let alerted = 0;
    for (let n = 0; n < 19; n++) if (alerts(at(n), at(n + 1))) alerted++;
    expect(alerted).toBe(1);
    expect(alerts(at(9), at(10))).toBe(true);
  });
  it('is silent between stamps, past the goal and on redeem', () => {
    for (const [a, b] of [
      [0, 1],
      [4, 5],
      [8, 9],
      [10, 12],
      [12, 15],
      [12, 2],
      [10, 0],
    ] as const)
      expect(alerts(at(a), at(b)), `${a}->${b}`).toBe(false);
  });
  it('words the alert as the header value', () => {
    expect(header(at(10)).changeMessage).toBe('%@');
    expect(header(at(7)).changeMessage).toBeUndefined();
  });
});

describe('stamps manifest checks', () => {
  const base = () => structuredClone(template.manifest) as TemplateManifest;
  const codes = (m: TemplateManifest, extra: string[] = []) =>
    stampsIssues(m, template.passJson, extra).map((i) => i.code);
  const withBlock = (patch: Record<string, unknown>) => {
    const m = base();
    m.stamps = { ...(m.stamps as object), ...patch } as never;
    return m;
  };

  it('accepts the blueprint without issues', () => {
    expect(stampsIssues(template.manifest, template.passJson)).toEqual([]);
    const all = validateManifest(template.manifest, {
      passJson: template.passJson,
      behaviors: bakedBehaviors,
      allowPattern: true,
      assetNames: template.assets.map((a) => a.name),
    });
    expect(all.filter((i) => i.code.startsWith('STAMPS') || i.code === 'EXPR_PASS')).toEqual([]);
  });
  it.each([2, 21, 7.5, '8'])('refuses goal %s', (goal) => {
    expect(codes(withBlock({ goal }))).toContain('STAMPS_GOAL');
  });
  it('refuses a missing or non-integer input', () => {
    expect(codes(withBlock({ input: 'nope' }))).toContain('STAMPS_INPUT');
    expect(codes(withBlock({ input: 'holder' }))).toContain('STAMPS_INPUT');
  });
  it('refuses an input name that is not a plain name, even when the input exists', () => {
    // The name is read through a JSON path: quotes and dots never get that far.
    for (const input of ['a"b', 'a.b', '1abc', 'a b', 'x'.repeat(65)]) {
      const m = withBlock({ input });
      (m.inputs.properties as Record<string, unknown>)[input] = { type: 'integer', minimum: 0 };
      expect(codes(m)).toContain('STAMPS_INPUT');
    }
    // Positive control: a plain name that exists is fine.
    const ok = withBlock({ input: 'visits_2' });
    (ok.inputs.properties as Record<string, unknown>).visits_2 = { type: 'integer', minimum: 0 };
    expect(codes(ok)).not.toContain('STAMPS_INPUT');
  });
  it('refuses a maximum under the goal and warns below a full card', () => {
    const m = base();
    (m.inputs.properties as Record<string, Record<string, unknown>>).stamps!.maximum = 9;
    expect(codes(m)).toContain('STAMPS_MAX');
    (m.inputs.properties as Record<string, Record<string, unknown>>).stamps!.maximum = 12;
    expect(codes(m)).toContain('STAMPS_MAX_LOW');
  });
  it('wants filled and empty art', () => {
    expect(codes(withBlock({ art: { filled: 'stamps/filled.png' } }))).toContain('STAMPS_ART');
  });
  it('refuses a style without a strip', () => {
    const generic = { formatVersion: 1, generic: { primaryFields: [] } } as unknown as PassJson;
    expect(stampsIssues(base(), generic).map((i) => i.code)).toContain('STAMPS_STYLE');
  });
  it('refuses localized strips', () => {
    expect(codes(base(), ['en.lproj/strip@2x.png'])).toContain('STAMPS_LOCALIZED');
  });
  it('warns when a changeMessage fires on every stamp', () => {
    const m = base();
    m.bindings = m.bindings.map((b) => {
      const { when: _when, ...rest } = b;
      return (b.to as { prop?: string }).prop === 'changeMessage' ? (rest as typeof b) : b;
    });
    expect(codes(m)).toContain('STAMPS_CHATTY');
  });
  it('warns when nothing tells holders the reward is ready', () => {
    const m = base();
    m.bindings = m.bindings.filter((b) => (b.to as { prop?: string }).prop !== 'changeMessage');
    expect(codes(m)).toContain('STAMPS_SILENT');
  });
  it('wants a scan take on the count to redeem the goal, and lets its adds notify', () => {
    const m = base();
    const take = (amount: number) => ({
      id: 'redeem',
      label: 'Redeem reward',
      kind: 'take' as const,
      input: 'stamps',
      amount,
    });
    const add = {
      id: 'stamp',
      label: 'Add stamp',
      kind: 'add' as const,
      input: 'stamps',
      amount: 1,
      notify: true,
    };
    m.scan = { actions: [take(5), add] };
    expect(codes(m)).toContain('SCAN_STAMPS_GOAL');
    m.scan = { actions: [take(10), add] };
    expect(codes(m)).not.toContain('SCAN_STAMPS_GOAL');
    const all = validateManifest(m, {
      passJson: template.passJson,
      behaviors: bakedBehaviors,
      allowPattern: true,
    });
    expect(all.map((i) => i.code)).not.toContain('SCAN_NOTIFY_BUDGET');
    const other = structuredClone(m);
    (other.inputs.properties as Record<string, unknown>).visits = { type: 'integer', minimum: 0 };
    other.scan = { actions: [{ ...add, input: 'visits' }] };
    const plain = validateManifest(other, {
      passJson: template.passJson,
      behaviors: bakedBehaviors,
      allowPattern: true,
    });
    expect(plain.map((i) => i.code)).toContain('SCAN_NOTIFY_BUDGET');
  });
  it('warns about primary fields', () => {
    const pass = structuredClone(template.passJson) as unknown as {
      storeCard: Record<string, unknown>;
    };
    pass.storeCard.primaryFields = [{ key: 'x', value: 'y' }];
    expect(stampsIssues(base(), pass as unknown as PassJson).map((i) => i.code)).toContain(
      'STAMPS_PRIMARY',
    );
  });
});
