import { describe, expect, it } from 'vitest';
import { fidelityReport } from '../fidelity.ts';
import type { ViewBarcode, ViewImageFile, WalletPassView } from '../types.ts';
import { NOW } from '../view-fixtures.ts';
import { GOOGLE_COMPILERS, googleCompiler } from './compilers.ts';
import { googleView } from './fixtures.ts';
import type { GoogleType } from './types.ts';

const OPTIONS = { now: NOW, omit: [] };
const barcode = (
  kind: ViewBarcode['kind'],
  message = 'ABC',
  encoding = 'iso-8859-1',
): ViewBarcode => ({
  format: `PKBarcodeFormat${kind === 'qr' ? 'QR' : kind[0]?.toUpperCase()}${kind === 'qr' ? '' : kind.slice(1)}`,
  kind,
  message,
  encoding,
});
const compile = async (
  slug: string,
  type: GoogleType,
  patch?: (view: WalletPassView) => void,
  omit: string[] = [],
) => GOOGLE_COMPILERS[type].compile(await googleView(slug, { patch }), { now: NOW, omit });
const object = (r: { objectBody?: unknown }) => r.objectBody as Record<string, any>;

describe('barcodes', () => {
  const TYPES = {
    qr: 'QR_CODE',
    pdf417: 'PDF_417',
    aztec: 'AZTEC',
    code128: 'CODE_128',
  } as const;
  for (const [kind, type] of Object.entries(TYPES))
    it(`${kind} is ${type}, message and alt text unchanged`, async () => {
      const r = await compile('starter-generic', 'generic', (v) => {
        v.barcodes = [{ ...barcode(kind as 'qr'), message: 'Aé\n 9', altText: 'A9' }];
      });
      expect(object(r).barcode).toEqual({
        type,
        renderEncoding: 'UTF_8',
        value: 'Aé\n 9',
        alternateText: 'A9',
      });
      // Not ASCII and not UTF-8 on the Apple side: the copy is exact, the encoding is a difference.
      expect(
        r.items.some(
          (i) => i.support === 'difference' && i.capability.startsWith('barcode.format.'),
        ),
      ).toBe(true);
    });

  it('takes the first format Google renders and reports the ones before it', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [
        barcode('i2of5', 'ABC'),
        barcode('i2of5', '12'),
        barcode('pdf417', 'P-1', 'utf-8'),
        barcode('qr', 'Q-1'),
      ];
    });
    expect(object(r).barcode.value).toBe('P-1');
    expect(
      r.items
        .filter((i) => i.support === 'omitted' && i.path.startsWith('barcodes.'))
        .map((i) => i.path),
    ).toEqual(['barcodes.0', 'barcodes.1']);
  });

  it('carries none when no format fits, and a required format blocks the template', async () => {
    const view = await googleView('starter-generic', {
      wallets: { required: ['barcode.format'] },
      patch: (v) => {
        v.barcodes = [barcode('i2of5', 'ABC')];
      },
    });
    expect(object(googleCompiler.compile(view, OPTIONS)).barcode).toBeUndefined();
    const report = fidelityReport({
      target: 'google',
      compiler: googleCompiler,
      views: [view],
      wallets: view.wallets,
      now: NOW,
    });
    expect(report.status.kind).toBe('blocked');
    expect(report.items[0]).toMatchObject({
      capability: 'barcode.format.i2of5',
      severity: 'blocked',
    });
  });
});

describe('barcodes: messages the type cannot encode', () => {
  const sent = async (kind: ViewBarcode['kind'], message: string) => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [barcode(kind, message)];
    });
    return { barcode: object(r).barcode, items: r.items };
  };
  it('sends valid EAN-13 (12 digits, or 13 with check digit), Code 39 and Codabar', async () => {
    expect((await sent('ean13', '4006381333931')).barcode.type).toBe('EAN_13');
    expect((await sent('ean13', '400638133393')).barcode.type).toBe('EAN_13');
    expect((await sent('code39', 'AB-12 $')).barcode.type).toBe('CODE_39');
    expect((await sent('codabar', 'A1234-5B')).barcode.type).toBe('CODABAR');
  });
  it('omits and reports an invalid message', async () => {
    for (const [kind, message] of [
      ['ean13', '4006381333932'],
      ['ean13', '12345'],
      ['code39', 'abc'],
      ['codabar', 'A12x4B'],
    ] as const) {
      const r = await sent(kind, message);
      expect(r.barcode, `${kind} ${message}`).toBeUndefined();
      expect(r.items).toContainEqual(
        expect.objectContaining({ capability: `barcode.format.${kind}`, support: 'omitted' }),
      );
    }
  });
});

describe('barcodes: interleaved 2 of 5', () => {
  it('goes out as ITF-14 for 14 digits and says so', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [barcode('i2of5', '12345678901231')];
    });
    expect(object(r).barcode.type).toBe('ITF_14');
    expect(r.items).toContainEqual(
      expect.objectContaining({ capability: 'barcode.format.i2of5', support: 'difference' }),
    );
  });
});

describe('a voided pass', () => {
  for (const [slug, type] of [
    ['starter-generic', 'generic'],
    ['starter-event-ticket', 'event'],
    ['starter-store-card', 'loyalty'],
    ['starter-coupon', 'offer'],
  ] as const)
    it(`${type} is INACTIVE with no barcode and one message`, async () => {
      const r = await compile(slug, type, (v) => {
        v.validity.voided = true;
      });
      expect(object(r).state).toBe('INACTIVE');
      expect(object(r).barcode).toBeUndefined();
      expect(object(r).messages).toEqual([
        {
          id: 'voided',
          header: 'Pass voided',
          body: 'This pass is no longer valid.',
          messageType: 'TEXT',
        },
      ]);
    });

  it('is ACTIVE again when unvoided', async () => {
    const r = await compile('starter-generic', 'generic');
    expect(object(r).state).toBe('ACTIVE');
    expect(object(r).messages).toBeUndefined();
    expect(object(r).barcode).toBeDefined();
  });
});

describe('identity values are never shortened (Q20)', () => {
  const blocked = (r: { blocked?: { code: string } }) => r.blocked?.code;

  it('blocks a barcode message over the byte limit and passes one at the limit', async () => {
    const at = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [barcode('qr', 'x'.repeat(2953), 'utf-8')];
    });
    expect(blocked(at)).toBeUndefined();
    expect(object(at).barcode.value).toHaveLength(2953);
    const over = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [barcode('qr', 'x'.repeat(2954), 'utf-8')];
    });
    expect(over.blocked?.code).toBe('IDENTITY_TOO_LONG');
    expect(over.objectBody).toBeUndefined();
  });

  it('counts bytes, not characters, for the barcode', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.barcodes = [barcode('qr', '€'.repeat(1000), 'utf-8')];
    });
    expect(r.blocked?.code).toBe('IDENTITY_TOO_LONG');
  });

  it('keeps a member id whole at 512 characters and blocks 513', async () => {
    const withId = (n: number) => (v: WalletPassView) => {
      v.roles.memberId = { kind: 'text', text: 'm'.repeat(n), source: 'manifest', fields: [] };
    };
    expect(object(await compile('starter-store-card', 'loyalty', withId(512))).accountId).toBe(
      'm'.repeat(512),
    );
    expect((await compile('starter-store-card', 'loyalty', withId(513))).blocked?.code).toBe(
      'IDENTITY_TOO_LONG',
    );
  });

  it('blocks a ticket number, a gift card number and a pin that do not fit', async () => {
    const long =
      (role: 'ticketNumber' | 'giftCardNumber' | 'giftCardPin') => (v: WalletPassView) => {
        v.roles[role] = { kind: 'text', text: '9'.repeat(513), source: 'manifest', fields: [] };
        if (role === 'giftCardPin')
          v.roles.giftCardNumber = { kind: 'text', text: '1', source: 'manifest', fields: [] };
      };
    expect(
      (await compile('starter-event-ticket', 'event', long('ticketNumber'))).blocked?.code,
    ).toBe('IDENTITY_TOO_LONG');
    expect(
      (await compile('starter-store-card', 'gift', long('giftCardNumber'))).blocked?.code,
    ).toBe('IDENTITY_TOO_LONG');
    expect((await compile('starter-store-card', 'gift', long('giftCardPin'))).blocked?.code).toBe(
      'IDENTITY_TOO_LONG',
    );
  });

  it('a blocked pass makes the report Blocked', async () => {
    const view = await googleView('starter-generic', {
      patch: (v) => {
        v.barcodes = [barcode('qr', 'x'.repeat(3000), 'utf-8')];
      },
    });
    const report = fidelityReport({
      target: 'google',
      compiler: googleCompiler,
      views: [view],
      now: NOW,
    });
    expect(report.status).toEqual({
      kind: 'blocked',
      reason: 'barcodes.0 is longer than 2953 bytes.',
    });
  });
});

describe('display text is shortened and reported (Q20)', () => {
  it('cuts a long title at a grapheme with an ellipsis and says so once', async () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const title = `${'a'.repeat(98)}${family}${family}`;
    const r = await compile('starter-generic', 'generic', (v) => {
      v.roles.title = { kind: 'text', text: title, source: 'manifest', fields: [] };
    });
    expect(object(r).header.defaultValue.value).toBe(`${'a'.repeat(98)}…`);
    expect(r.items.filter((i) => i.capability === 'text.length')).toEqual([
      {
        capability: 'text.length',
        path: 'title',
        support: 'difference',
        message: 'Shortened to 100 characters.',
      },
    ]);
  });

  it('cuts a module body at 500 characters', async () => {
    let path = '';
    const r = await compile('starter-generic', 'generic', (v) => {
      const field = v.fields.find((f) => f.group === 'back');
      if (!field) throw new Error('no back field');
      path = field.path;
      field.text = 'w '.repeat(400);
    });
    const body = object(r).textModulesData.find((m: { id: string }) => m.id === path)
      .body as string;
    expect([...body]).toHaveLength(500);
    expect(body.endsWith('…')).toBe(true);
  });

  it('strips markup and controls from every display string', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.roles.title = {
        kind: 'text',
        text: '<b>Alex</b>\u0007Morgan',
        source: 'manifest',
        fields: [],
      };
    });
    expect(object(r).header.defaultValue.value).toBe('Alex Morgan');
  });
});

describe('images (Q18)', () => {
  const file = (over: Partial<ViewImageFile>): ViewImageFile => ({
    name: 'thumbnail@3x.png',
    slot: 'thumbnail',
    scale: 3,
    width: 2400,
    height: 2400,
    personal: false,
    url: 'https://img.example/thumb',
    ...over,
  });

  it('never sends a personal image, even one that holds a URL, and reports it', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.images.apple.thumbnail = [
        file({ name: 'member-photo.png', personal: true, url: 'https://img.example/me' }),
      ];
      v.images.apple.icon = [
        file({ name: 'icon@3x.png', slot: 'icon', personal: true, url: 'https://img.example/me2' }),
      ];
    });
    expect(JSON.stringify(r)).not.toContain('img.example/me');
    expect(r.items).toContainEqual({
      capability: 'image.personal',
      path: 'images.thumbnail',
      support: 'omitted',
      message: 'Personal images are never sent to Google.',
    });
  });

  it('carries a template thumbnail that is large enough as an image module', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.images.apple.thumbnail = [file({})];
    });
    expect(object(r).imageModulesData[0]).toMatchObject({
      id: 'thumbnail',
      mainImage: { sourceUri: { uri: 'https://img.example/thumb' } },
    });
  });

  it('does not upscale: a small file leaves the slot empty and says why', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.images.apple.thumbnail = [file({ width: 810 })];
    });
    expect(object(r).imageModulesData).toBeUndefined();
    expect(r.items).toContainEqual({
      capability: 'image.thumbnail',
      path: 'images.thumbnail',
      support: 'omitted',
      message: 'thumbnail@3x.png is 810 px wide; Google needs 1860.',
    });
  });

  it('leaves a file with no public URL out', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.images.apple.thumbnail = [file({ url: undefined })];
    });
    expect(r.items.find((i) => i.capability === 'image.thumbnail')?.message).toBe(
      'thumbnail@3x.png has no public URL.',
    );
  });

  it('says a strip below the hero size is the problem, not its address', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.images.apple = {};
      v.images.overrides = {};
      v.images.apple.strip = [
        file({ name: 'strip@2x.png', slot: 'strip', width: 640, height: 200, url: undefined }),
      ];
    });
    expect(r.items.find((i) => i.capability === 'image.strip')?.message).toBe(
      'The strip (hero) image is 640 x 200; Google needs 1032 px wide. Replace it.',
    );
  });

  it('uses the default of a localized image and says so', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.images.apple.thumbnail = [file({ locale: 'fr' }), file({})];
    });
    expect(r.items).toContainEqual({
      capability: 'localization.images',
      path: 'images.thumbnail',
      support: 'difference',
      message: 'Localized images use the default image.',
    });
    expect(object(r).imageModulesData).toHaveLength(1);
  });

  it('a Generic pass without a big enough logo shows the first letter', async () => {
    const view = await googleView('starter-generic', { art: false });
    const r = googleCompiler.compile(view, OPTIONS);
    expect(object(r).logo).toBeUndefined();
    expect(r.items.find((i) => i.capability === 'image.icon')?.message).toMatch(
      /first letter of the title\.$/u,
    );
  });
});

describe('localization', () => {
  it('adds translated values by locale and normalizes the tag', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.localization = {
        en: { 'Alex Morgan': 'Alex' },
        pt_BR: { 'Alex Morgan': 'Alexandre', Created: 'Criado' },
        fr: { 'Alex Morgan': 'Alexandre M.' },
      };
      v.roles.title = { kind: 'text', text: 'Alex Morgan', source: 'manifest', fields: [] };
      for (const f of v.fields) f.label = f.label === 'Created' ? 'Created' : f.label;
    });
    expect(object(r).header).toEqual({
      defaultValue: { language: 'en', value: 'Alex Morgan' },
      translatedValues: [
        { language: 'fr', value: 'Alexandre M.' },
        { language: 'pt-BR', value: 'Alexandre' },
      ],
    });
  });
});
