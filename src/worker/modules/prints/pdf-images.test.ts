import { describe, expect, it, vi } from 'vitest';

const opened = { reads: 0, cancels: 0 };
const files = new Map<string, { etag: string; size: number }>();

vi.mock('../public/service.ts', () => ({
  openPublicAsset: async (_ctx: unknown, _pass: unknown, name: string) => {
    const file = files.get(name) as { etag: string; size: number };
    let sent = 0;
    return {
      etag: file.etag,
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent === 0) opened.reads++;
            const n = Math.min(64 * 1024, file.size - sent);
            if (n <= 0) controller.close();
            else controller.enqueue(new Uint8Array(n));
            sent += n;
          },
          cancel() {
            opened.cancels++;
          },
          // Pull only when a reader asks, so a read is a body somebody consumed.
        },
        { highWaterMark: 0 },
      ),
    };
  },
}));

const { imageIds, loadImages } = await import('./pdf-images.ts');
const { MAX_DISTINCT_IMAGES } = await import('./pdf-render.ts');
const { MAX_IMAGE_BYTES } = await import('./pdf-png.ts');

const warnings: string[] = [];
const ctx = {
  log: { warn: (_m: string, d: { code: string }) => warnings.push(d.code) },
} as never;
const pass = { id: 'p1' } as never;

describe('bulk image loading', () => {
  it('reads at most the cap of distinct image bodies, and each shared one once', async () => {
    opened.reads = 0;
    const cache = new Map();
    for (let i = 0; i < 30; i++) {
      files.set(`art-${i}`, { etag: `"e${i}"`, size: 1000 });
      await loadImages(ctx, pass, { art: `art-${i}` }, cache);
      await loadImages(ctx, pass, { art: `art-${i}` }, cache);
    }
    expect(opened.reads).toBe(MAX_DISTINCT_IMAGES);
    expect(warnings).toContain('PRINT_PDF_IMAGE_LIMIT');
  });

  it('stops reading a file past the size limit', async () => {
    warnings.length = 0;
    files.set('big', { etag: '"big"', size: 50 * 1024 * 1024 });
    opened.reads = 0;
    opened.cancels = 0;
    const out = await loadImages(ctx, pass, { logo: 'big' }, new Map());
    expect(out).toEqual({});
    expect(opened.cancels).toBe(1);
    expect(warnings).toEqual(['PRINT_PDF_IMAGE_INVALID']);
    expect(MAX_IMAGE_BYTES).toBe(2_000_000);
  });

  it('names a replaced image differently, so a cached PDF made with the old one is not served', async () => {
    files.set('logo', { etag: '"v1"', size: 10 });
    const before = await imageIds(ctx, pass, { logo: 'logo' });
    files.set('logo', { etag: '"v2"', size: 10 });
    const after = await imageIds(ctx, pass, { logo: 'logo' });
    expect(before.logo).toBe('"v1"');
    expect(after.logo).toBe('"v2"');
  });
});
