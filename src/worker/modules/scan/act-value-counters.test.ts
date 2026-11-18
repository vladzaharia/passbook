import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import {
  releaseStamps,
  STAMP_CARD,
  stampCard,
  stampVersion,
} from '../passes/stamps-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';

beforeAll(setupActionFixture);

let sequence = 0;
const SIZE = 10;

/** The stamp card's package turned into a counter: `uses` left, `Use one` and a `Refill` of 5. */
async function counterTemplate(maximum: number | undefined) {
  const id = `counter-${sequence++}-${kit.fx.ids.token(3)}`;
  const manifest = structuredClone(STAMP_CARD.manifest) as TemplateManifest;
  delete manifest.stamps;
  manifest.bindings = manifest.bindings.filter((b) => !JSON.stringify(b).includes('pass.stamps'));
  manifest.display = { title: '{{holder}}', subtitle: '{{cardNumber}}' };
  const props = manifest.inputs.properties as Record<string, Record<string, unknown>>;
  props.stamps = {
    type: 'integer',
    minimum: 0,
    default: SIZE,
    ...(maximum ? { maximum } : {}),
  };
  manifest.counters = { uses: { input: 'stamps', size: SIZE } };
  manifest.scan = {
    actions: [
      { id: 'use', label: 'Use one', kind: 'take', input: 'stamps', amount: 1, repeat: 'always' },
      { id: 'refill', label: 'Refill', kind: 'add', input: 'stamps', amount: 5, repeat: 'always' },
    ],
  } as never;
  const resolved = kit.registry.add({
    id,
    version: 'v1',
    orgId: kit.org.id,
    manifest,
    passJson: structuredClone(STAMP_CARD.passJson) as PassJson,
    assets: {
      'icon@2x.png': makePng(58, 58),
      'icon@3x.png': makePng(87, 87),
      'logo@2x.png': makePng(100, 100),
      'logo@3x.png': makePng(150, 150),
    },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  return { id, release: await releaseStamps(kit, id, 'v1') };
}

async function scanner(
  id: string,
  release: Awaited<ReturnType<typeof releaseStamps>>,
  left: number,
) {
  const pass = await stampCard(kit, release, left);
  const s = await kit.scanner({ templateIds: [id], settings: { roleWithoutSignIn: 'desk' } });
  return (actionId: string) =>
    act(s.headers, { code: pass.scanCode ?? '', method: 'camera' }, { actionId });
}

describe('counter refusals at the scanner', () => {
  it('flags no_balance on a counter that has none left', async () => {
    const { id, release } = await counterTemplate(undefined);
    const scan = await scanner(id, release, 1);
    expect((await out(await scan('use'))).kind).toBe('ok');
    const none = await out(await scan('use'));
    expect(none).toMatchObject({
      kind: 'refused',
      reason: 'no_balance',
      value: { after: 0, goal: SIZE, counter: true },
    });
  });

  it('flags card_full on a refill past the input maximum, and loses nothing', async () => {
    const { id, release } = await counterTemplate(12);
    const scan = await scanner(id, release, 9);
    const full = await out(await scan('refill'));
    expect(full).toMatchObject({
      kind: 'refused',
      reason: 'card_full',
      value: { after: 9, counter: true },
    });
    for (let i = 0; i < 3; i++) expect((await out(await scan('use'))).kind).toBe('ok');
    expect((await out(await scan('refill'))).kind).toBe('ok');
  });

  it('does not flag a stamp card refusal', async () => {
    const id = `stamps-flag-${sequence++}-${kit.fx.ids.token(3)}`;
    await stampVersion(kit, id, 'v1', 10);
    const release = await releaseStamps(kit, id, 'v1');
    const scan = await scanner(id, release, 2);
    const short = await out(await scan('redeem'));
    expect(short).toMatchObject({ kind: 'refused', reason: 'no_balance' });
    expect(short.value).not.toBeNull();
    expect(short.value).not.toHaveProperty('counter');
  });
});
