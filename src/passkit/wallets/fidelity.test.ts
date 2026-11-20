import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import type { WalletsManifest } from '../template/wallets/schema.ts';
import {
  canonicalJson,
  fidelityReport,
  omissionKey,
  omissionKeys,
  reportHash,
  statusLabel,
} from './fidelity.ts';
import { lengthItem } from './text.ts';
import type { CompileResult, FidelityItem, WalletCompiler, WalletPassView } from './types.ts';
import { NOW, viewOf } from './view-fixtures.ts';

const item = (
  capability: FidelityItem['capability'],
  support: FidelityItem['support'],
  path = '',
  message = `${capability} ${support}`,
): FidelityItem => ({ capability, path, support, message });

const fixed = (...results: Partial<CompileResult>[]): WalletCompiler => {
  let call = 0;
  return {
    target: 'google',
    revision: 3,
    compile: () => ({ type: 'generic', items: [], ...(results[call++ % results.length] ?? {}) }),
  };
};

const VIEW = {} as WalletPassView;
const report = (
  compiler: WalletCompiler,
  wallets?: WalletsManifest,
  views: readonly WalletPassView[] = [VIEW],
) =>
  fidelityReport({ target: 'google', compiler, views, ...(wallets ? { wallets } : {}), now: NOW });

describe('fidelityReport statuses', () => {
  it('is Ready when everything is native or text', () => {
    const r = report(
      fixed({ items: [item('field.back', 'native'), item('role.tier', 'text', 'x')] }),
    );
    expect(r).toEqual({
      schema: 1,
      target: 'google',
      type: 'generic',
      compilerRevision: 3,
      status: { kind: 'ready' },
      items: [],
    });
    expect(statusLabel(r.status)).toBe('Ready');
  });

  it('counts omissions and lists differences without approving them', () => {
    const r = report(
      fixed({
        items: [
          item('colors.foreground', 'difference'),
          item('relevance.beacons', 'unsupported', 'beacons'),
          item('field.back', 'omitted', 'backFields.terms'),
        ],
      }),
    );
    expect(r.status).toEqual({ kind: 'omissions', count: 1 });
    expect(statusLabel(r.status)).toBe('Ready with omissions (1)');
    expect(r.items.map((i) => `${i.severity} ${i.capability}`)).toEqual([
      'difference colors.foreground',
      'omission field.back',
      'omission relevance.beacons',
    ]);
    expect(omissionKeys(r)).toEqual(['field.back@backFields.terms']);
  });

  it('tags each item with who notices it and approves only holder and door', () => {
    const r = report(
      fixed({
        items: [
          item('field.back', 'omitted', 'backFields.a'),
          item('barcode.format.pdf417', 'omitted', 'barcodes.0'),
          item('colors.label', 'omitted'),
          item('role.tier', 'difference'),
          item('nfc', 'unsupported'),
          item('relevance.beacons', 'unsupported', 'beacons'),
        ],
      }),
    );
    expect(r.items.map((i) => `${i.capability} ${i.group}`)).toEqual([
      'barcode.format.pdf417 door',
      'colors.label look',
      'field.back holder',
      'nfc door',
      'relevance.beacons absent',
      'role.tier look',
    ]);
    expect(r.status).toEqual({ kind: 'omissions', count: 3 });
    expect(omissionKeys(r)).toEqual([
      'barcode.format.pdf417@barcodes.0',
      'field.back@backFields.a',
      'nfc',
    ]);
  });

  it('is Ready when only look and absent items remain', () => {
    const r = report(
      fixed({ items: [item('colors.label', 'omitted'), item('relevance.beacons', 'unsupported')] }),
    );
    expect(r.status).toEqual({ kind: 'ready' });
    expect(r.items).toHaveLength(2);
    expect(omissionKeys(r)).toEqual([]);
  });

  it('only differences leave the report Ready', () => {
    const r = report(fixed({ items: [item('colors.foreground', 'difference')] }));
    expect(r.status).toEqual({ kind: 'ready' });
    expect(r.items).toHaveLength(1);
  });

  it('marks author-chosen omissions by path, bare key or capability id', () => {
    const items = [
      item('field.back', 'omitted', 'backFields.terms'),
      item('field.back', 'omitted', 'backFields.legal'),
      item('field.back', 'omitted', 'backFields.fine'),
      item('relevance.beacons', 'omitted', 'beacons'),
      item('nfc', 'unsupported'),
    ];
    const r = report(fixed({ items }), {
      schema: 1,
      google: { omit: ['backFields.terms', 'legal', 'relevance.beacons'] },
    });
    expect(r.items.map((i) => `${i.capability}@${i.path} ${i.chosen}`)).toEqual([
      'field.back@backFields.fine false',
      'field.back@backFields.legal true',
      'field.back@backFields.terms true',
      'nfc@ false',
      'relevance.beacons@beacons true',
    ]);
    expect(r.status).toEqual({ kind: 'omissions', count: 5 });
  });

  it('blocks when a required capability is anything but native', () => {
    const wallets: WalletsManifest = { schema: 1, required: ['barcode.format', 'type'] };
    const omitted = report(
      fixed({
        items: [
          item('barcode.format.code128', 'omitted', 'barcodes.0', 'Code 128 is not offered.'),
        ],
      }),
      wallets,
    );
    expect(omitted.status).toEqual({
      kind: 'blocked',
      reason: 'barcode.format.code128 is required: Code 128 is not offered.',
    });
    expect(omitted.items[0]?.severity).toBe('blocked');
    expect(statusLabel(omitted.status)).toBe(
      'Blocked: barcode.format.code128 is required: Code 128 is not offered.',
    );
    // A text fallback and a type fallback are not native either.
    expect(
      report(fixed({ items: [item('type', 'omitted', '', 'Generic instead.')] }), wallets).status
        .kind,
    ).toBe('blocked');
    expect(report(fixed({ items: [item('type', 'text')] }), wallets).status.kind).toBe('blocked');
    // A required id covers its children only.
    expect(
      report(fixed({ items: [item('barcode.altText', 'omitted')] }), wallets).status.kind,
    ).toBe('omissions');
    expect(
      report(fixed({ items: [item('barcode.format.qr', 'native')] }), wallets).status.kind,
    ).toBe('ready');
  });

  it('blocks on a pass-level failure with its message', () => {
    const r = report(
      fixed({
        blocked: { code: 'IDENTITY_TOO_LONG', message: 'The member id is too long for Google.' },
      }),
    );
    expect(r.status).toEqual({ kind: 'blocked', reason: 'The member id is too long for Google.' });
  });

  it('is Off for a disabled target and never compiles', () => {
    let compiled = 0;
    const compiler: WalletCompiler = {
      target: 'google',
      revision: 1,
      compile: () => {
        compiled++;
        return { type: 'generic', items: [] };
      },
    };
    const r = report(compiler, { schema: 1, google: { type: 'off' } });
    expect(r).toMatchObject({ type: 'off', status: { kind: 'off' }, items: [] });
    expect(compiled).toBe(0);
    expect(statusLabel(r.status)).toBe('Off');
  });

  it('hands the omit list and the fixed clock to the compiler', () => {
    const seen: unknown[] = [];
    const compiler: WalletCompiler = {
      target: 'samsung',
      revision: 1,
      compile: (_view, options) => {
        seen.push(options);
        return { type: 'loyalty', items: [] };
      },
    };
    fidelityReport({
      target: 'samsung',
      compiler,
      views: [VIEW],
      wallets: { schema: 1, samsung: { omit: ['nfc'] } },
      now: NOW,
    });
    expect(seen).toEqual([{ now: NOW, omit: ['nfc'] }]);
  });
});

describe('fidelityReport order and hash', () => {
  const a = item('role.points', 'omitted', 'primaryFields.points');
  const b = item('field.back', 'omitted', 'backFields.b');
  const c = item('field.back', 'omitted', 'backFields.a');
  const d = item('colors.label', 'difference');

  it('sorts by capability id, then path, whatever the compiler returns', async () => {
    const one = report(fixed({ items: [a, b, c, d] }));
    const two = report(fixed({ items: [d, c, a, b] }));
    expect(two).toEqual(one);
    expect(one.items.map((i) => `${i.capability} ${i.path}`)).toEqual([
      'colors.label ',
      'field.back backFields.a',
      'field.back backFields.b',
      'role.points primaryFields.points',
    ]);
    expect(await reportHash(two)).toBe(await reportHash(one));
  });

  it('merges the samples and reports an item once', () => {
    const r = report(fixed({ items: [a, d] }, { items: [d, b] }, { items: [a] }), undefined, [
      VIEW,
      VIEW,
      VIEW,
    ]);
    expect(r.items.map((i) => i.capability)).toEqual(['colors.label', 'field.back', 'role.points']);
  });

  it('hashes the canonical report: key order is irrelevant, content is not', async () => {
    const one = report(fixed({ items: [a] }));
    const hash = await reportHash(one);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(await reportHash({ ...one, items: [...one.items] })).toBe(hash);
    expect(await reportHash(report(fixed({ items: [b] })))).not.toBe(hash);
    expect(await reportHash({ ...one, compilerRevision: 4 })).not.toBe(hash);
  });

  it('pins the hash of a fixed report', async () => {
    expect(await reportHash(report(fixed({ items: [a, b, c, d] })))).toMatchInlineSnapshot(
      `"c0f4cfffc94ce1659ee946f2e565d598ccefa8033a2e081c775022f462ce903a"`,
    );
  });

  it('keys omissions by capability and path', () => {
    expect(omissionKey({ capability: 'nfc', path: '' })).toBe('nfc');
    expect(omissionKey({ capability: 'field.back', path: 'backFields.t' })).toBe(
      'field.back@backFields.t',
    );
  });
});

/**
 * A stand-in for a real compiler, reading the view the way CW3 and CW4 will: what a small target
 * could not carry. It exercises the engine over every starter and baked template.
 */
const toy: WalletCompiler = {
  target: 'samsung',
  revision: 1,
  compile(view) {
    const items: FidelityItem[] = [];
    for (const f of view.fields.filter((x) => x.group === 'back').slice(6))
      items.push(item('field.back', 'omitted', f.path, `${f.key} does not fit.`));
    for (const [i, bc] of view.barcodes.entries())
      if (bc.kind !== 'qr')
        items.push(
          item(
            `barcode.format.${bc.kind}` as FidelityItem['capability'],
            'omitted',
            `barcodes.${i}`,
          ),
        );
    if (view.relevance.beacons.length)
      items.push(item('relevance.beacons', 'unsupported', 'beacons'));
    if (view.nfc) items.push(item('nfc', 'unsupported'));
    if (view.sharingProhibited) items.push(item('sharing', 'difference'));
    if (view.events.length > 1)
      items.push(item('upcoming.multi', 'difference', '', 'Only the next event.'));
    const title = view.roles.title;
    const long = lengthItem({
      path: 'title',
      limit: { unit: 'chars', max: 4 },
      ...(title && 'text' in title ? { value: title.text } : {}),
    });
    if (long) items.push(long);
    return {
      type: view.style === 'eventTicket' ? 'ticket' : 'loyalty',
      items,
    };
  },
};

describe('fidelityReport over every starter and baked template', () => {
  beforeAll(async () => {
    await loadBaked('starter-stamp-card');
  }, 120_000);

  it.each(bakedSlugs())('%s', async (slug) => {
    const view = await viewOf(slug);
    const r = fidelityReport({ target: 'samsung', compiler: toy, views: [view], now: NOW });
    expect({ ...r, label: statusLabel(r.status), hash: await reportHash(r) }).toMatchSnapshot();
    const again = fidelityReport({
      target: 'samsung',
      compiler: toy,
      views: [view, view],
      now: NOW,
    });
    expect(again).toEqual(r);
  });
});
