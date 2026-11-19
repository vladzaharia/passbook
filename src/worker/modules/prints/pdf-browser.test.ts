import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPdf } from './pdf-render.ts';

const calls: string[] = [];
let hang = false;
let closeFails = false;
let launchOptions: unknown;

vi.mock('@cloudflare/puppeteer', () => ({
  default: {
    launch: async (_binding: unknown, options: unknown) => {
      launchOptions = options;
      return {
        newPage: async () => ({
          setJavaScriptEnabled: async (on: boolean) => void calls.push(`js:${on}`),
          setRequestInterception: async (on: boolean) => void calls.push(`intercept:${on}`),
          on: (event: string, handler: (r: { abort: () => void }) => void) => {
            calls.push(`on:${event}`);
            handler({ abort: () => void calls.push('abort') });
          },
          setContent: async () => void calls.push('content'),
          emulateMediaType: async () => void calls.push('media'),
          pdf: async () => (hang ? new Promise<Uint8Array>(() => {}) : new Uint8Array([37, 80])),
        }),
        close: async () => {
          calls.push('close');
          if (closeFails) throw new Error('close failed');
        },
      };
    },
  },
}));

beforeEach(() => {
  calls.length = 0;
  hang = false;
  closeFails = false;
});

describe('browserPdf', () => {
  it('seals the page: no script, every request aborted, short keep-alive', async () => {
    const bytes = await browserPdf({} as never, '<p>x</p>');
    expect(bytes).toEqual(new Uint8Array([37, 80]));
    expect(calls).toEqual([
      'js:false',
      'intercept:true',
      'on:request',
      'abort',
      'content',
      'media',
      'close',
    ]);
    expect(launchOptions).toEqual({ keep_alive: 10_000 });
  });

  it('gives up after the overall limit and still closes the browser', async () => {
    hang = true;
    await expect(browserPdf({} as never, '<p>x</p>', undefined, 30)).rejects.toThrow(/timed out/);
    expect(calls).toContain('close');
  });

  it('logs a failed close instead of discarding the PDF', async () => {
    closeFails = true;
    const heard: unknown[] = [];
    const bytes = await browserPdf({} as never, '<p>x</p>', (e) => heard.push(e));
    expect(bytes).toEqual(new Uint8Array([37, 80]));
    expect(heard).toHaveLength(1);
  });
});
