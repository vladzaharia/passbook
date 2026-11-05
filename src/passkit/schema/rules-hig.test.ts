import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { pixelIssues } from './image-pixels.ts';
import { checkImageSize, IMAGE_RULES } from './image-rules.ts';
import { type Loose, type Mutator, pet, poster, run } from './rules-helpers.ts';
import { IMAGE_RULES as VALIDATOR_RULES } from './validate-images.ts';

const codes = (fixture: string, mutate: Mutator) =>
  run(fixture, mutate).issues.map((i) => `${i.severity}:${i.code}`);
const back = (p: Loose) => p.generic.backFields as Loose[];

describe('HIG lint', () => {
  const cases: [string, string, Mutator, string][] = [
    [
      'low text contrast',
      'generic',
      (p) => {
        p.backgroundColor = 'rgb(255, 255, 255)';
        p.foregroundColor = 'rgb(225, 225, 225)';
      },
      'warning:COLOR_CONTRAST',
    ],
    [
      'low label contrast',
      'generic',
      (p) => {
        p.backgroundColor = 'rgb(20, 20, 20)';
        p.foregroundColor = 'rgb(255, 255, 255)';
        p.labelColor = 'rgb(50, 50, 50)';
      },
      'warning:COLOR_CONTRAST',
    ],
    [
      'a primary value past 20 characters',
      'generic',
      (p) => {
        p.generic.primaryFields[0].value = 'Alexandra Montgomery-Smith';
      },
      'warning:FIELD_LENGTH',
    ],
    [
      'an example.com link on the back',
      'generic',
      (p) => {
        back(p).push({ key: 'site', label: 'Website', value: 'https://example.com/club' });
      },
      'warning:PLACEHOLDER_URL',
    ],
    [
      'a localhost action',
      'generic',
      (p) => {
        p.appLaunchURL = 'http://localhost:5173/open';
      },
      'warning:PLACEHOLDER_URL',
    ],
    [
      'no way to reach anyone on the back',
      'generic',
      (p) => {
        p.generic.backFields = [{ key: 'thanks', label: 'Thanks', value: 'See you soon' }];
      },
      'warning:BACK_CONTACT',
    ],
    [
      'a change message on free text',
      'generic',
      (p) => {
        back(p).push({ key: 'note', label: 'Note', value: 'Hi', changeMessage: '%@' });
      },
      'warning:CHANGE_MESSAGE_FREE_TEXT',
    ],
    [
      'the platform name in logoText',
      'generic',
      (p) => {
        p.logoText = 'Wallet';
      },
      'warning:LOGO_TEXT_PLATFORM',
    ],
    [
      'an image over 200 KB',
      'generic',
      (_p, a) => a.map((x) => (x.name === 'icon@3x.png' ? { ...x, size: 250_000 } : x)),
      'warning:IMAGE_BYTES',
    ],
    [
      'a package over 400 KB',
      'generic',
      (_p, a) => a.map((x) => ({ ...x, size: 150_000 })),
      'warning:PASS_SIZE',
    ],
    [
      'a UTC time at a known place',
      'generic',
      (p) => {
        p.locations = [{ latitude: 47.6, longitude: -122.3 }];
        p.generic.secondaryFields.push({
          key: 'doors',
          label: 'Doors',
          value: '2026-06-01T02:00Z',
          timeStyle: 'PKDateStyleShort',
        });
      },
      'warning:LOCAL_TIME',
    ],
    [
      'a linear barcode on a poster',
      poster,
      (p) => {
        p.barcodes = [
          { format: 'PKBarcodeFormatCode128', message: 'A1', messageEncoding: 'utf-8' },
        ];
      },
      'info:POSTER_LINEAR_BARCODE',
    ],
  ];

  it.each(cases)('flags %s', (_name, fixture, mutate, code) => {
    expect(codes(fixture, mutate)).toContain(code);
  });

  it('stays quiet on a pass that follows the guidelines', () => {
    const quiet = codes('generic', () => {});
    for (const code of ['FIELD_LENGTH', 'PLACEHOLDER_URL', 'BACK_CONTACT', 'LOGO_TEXT_PLATFORM'])
      expect(quiet.some((c) => c.endsWith(code))).toBe(false);
  });

  it('reminds image-backed passes to check contrast, as info', () => {
    expect(codes(pet, () => {})).toContain('info:COLOR_CONTRAST');
  });

  it('rejects a UTC time shown as local, and warns for a UTC date that is not midnight', () => {
    const field = (value: string, timeStyle: string) =>
      codes('generic', (p) => {
        p.generic.secondaryFields.push({
          key: 'doors',
          label: 'Doors',
          value,
          dateStyle: 'PKDateStyleMedium',
          timeStyle,
          ignoresTimeZone: true,
        });
      });
    expect(field('2026-11-17T01:00:00Z', 'PKDateStyleShort')).toContain('error:LOCAL_TIME');
    expect(field('2026-11-17T01:00:00Z', 'PKDateStyleNone')).toContain('warning:LOCAL_TIME');
    expect(field('2026-01-01T00:00:00Z', 'PKDateStyleNone').join()).not.toContain('LOCAL_TIME');
  });

  it('accepts a local offset with ignoresTimeZone', () => {
    const out = codes('generic', (p) => {
      p.locations = [{ latitude: 47.6, longitude: -122.3 }];
      p.generic.secondaryFields.push({
        key: 'doors',
        label: 'Doors',
        value: '2026-06-01T19:00-07:00',
        timeStyle: 'PKDateStyleShort',
        ignoresTimeZone: true,
      });
    });
    expect(out).not.toContain('warning:LOCAL_TIME');
  });
});

/** RGBA PNG from a pixel function (filter 0 rows). */
function png(
  width: number,
  height: number,
  alpha: (x: number, y: number) => number,
  color: [number, number, number] = [40, 80, 120],
): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 4 + 1) + 1 + x * 4;
      raw.set([...color, alpha(x, y)], at);
    }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    return out; // CRC left zero: the lint decodes pixels, not checksums.
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('pixel lint', () => {
  it('flags a logo with a wide transparent margin, not a trimmed one', () => {
    const padded = png(100, 40, (x) => (x < 30 ? 0 : 255));
    const tight = png(100, 40, () => 255);
    expect(pixelIssues('logo@2x.png', 'logo', padded).map((i) => i.code)).toEqual([
      'IMAGE_PADDING',
    ]);
    expect(pixelIssues('logo@2x.png', 'logo', tight)).toEqual([]);
  });

  it('flags a logo with a 33% trailing or a bottom margin', () => {
    const trailing = png(300, 100, (x) => (x < 200 ? 255 : 0));
    const bottom = png(100, 100, (_x, y) => (y < 70 ? 255 : 0));
    expect(pixelIssues('logo@2x.png', 'logo', trailing).map((i) => i.code)).toEqual([
      'IMAGE_PADDING',
    ]);
    expect(pixelIssues('logo@2x.png', 'logo', bottom).map((i) => i.code)).toEqual([
      'IMAGE_PADDING',
    ]);
  });

  it('warns COLOR_CONTRAST with the ratio when artwork is light under the header', () => {
    const white: [number, number, number] = [255, 255, 255];
    const pastel = png(100, 200, () => 255, [226, 201, 196]);
    const [issue] = pixelIssues('artwork@2x.png', 'artwork', pastel, white);
    expect(issue?.code).toBe('COLOR_CONTRAST');
    expect(issue?.message).toContain('1.6:1');
    const dark = png(100, 200, () => 255, [49, 46, 129]);
    expect(pixelIssues('artwork@2x.png', 'artwork', dark, white)).toEqual([]);
    expect(pixelIssues('artwork@2x.png', 'artwork', pastel)).toEqual([]);
  });

  it('flags a thumbnail with square opaque corners, not a rounded one', () => {
    const square = png(60, 60, () => 255);
    const rounded = png(60, 60, (x, y) => (x + y < 6 ? 0 : 255));
    expect(pixelIssues('thumbnail.png', 'thumbnail', square).map((i) => i.code)).toEqual([
      'THUMBNAIL_CORNERS',
    ]);
    expect(pixelIssues('thumbnail.png', 'thumbnail', rounded)).toEqual([]);
  });
});

describe('IMAGE_RULES', () => {
  it('is the table the validator reads', () => {
    expect(VALIDATOR_RULES).toBe(IMAGE_RULES);
  });

  it('names the expected size in points times the scale', () => {
    expect(checkImageSize('artwork.png', 'artwork', 1, 540, 720)).toMatchObject({
      level: 'error',
      message: 'artwork.png must be 358 × 448 px.',
    });
    expect(checkImageSize('thumbnail@2x.png', 'thumbnail', 2, 600, 600)).toMatchObject({
      level: 'error',
      message: expect.stringContaining('180 × 180 px'),
    });
    expect(checkImageSize('strip@2x.png', 'strip', 2, 750, 288)).toEqual({ level: 'ok' });
    expect(checkImageSize('footer.png', 'footer', 1, 286, 15).level).toBe('warning');
    expect(checkImageSize('footer@2x.png', 'footer', 2, 536, 30)).toEqual({ level: 'ok' });
  });
});
