import { describe, expect, it } from 'vitest';
import { resolvePaper } from '../../../passkit/template/paper.ts';
import { fallbackPdf } from './pdf-fallback.ts';
import { pdfText } from './pdf-test-fixtures.ts';

const design = resolvePaper(undefined);
const sheet = (holder: string, venue = 'Hall') => ({
  design,
  code: 'PFM3CZW77MCQRJHH2FZ7A73R5XY',
  content: { brand: 'Brand', event: 'Show', venue, holder, extras: [] },
});

describe('pdf-lib fallback text', () => {
  it('never throws on CJK or emoji, and says once that text was replaced', async () => {
    let lossy = 0;
    const bytes = await fallbackPdf([sheet('山田 太郎 🎫', '東京ホール'), sheet('李雷 😀')], () => {
      lossy++;
    });
    expect(lossy).toBe(1);
    const text = await pdfText(bytes);
    expect(text).toContain('Show');
    expect(text).toMatch(/\?+/);
  });

  it('keeps the closest Latin-1 form where one exists', async () => {
    let lossy = 0;
    const bytes = await fallbackPdf([sheet('Zoë Ångström ｆｕｌｌ ńá', 'Škoda Hall')], () => {
      lossy++;
    });
    expect(lossy).toBe(0);
    const text = await pdfText(bytes);
    expect(text).toContain('Zoë Ångström full ná');
    expect(text).toContain('koda Hall');
    expect(text).not.toContain('?');
  });
});
