import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type PaperDesign, resolvePaper } from '../../passkit/template/paper.ts';
import { blueprintPass } from '../../passkit/template/paper-blueprint-fixtures.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../passkit/template/paper-fixtures.ts';
import { TEST_BAND_COPY } from '../../shared/copy/developer.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { ChannelPreviews } from '../channel-previews/channel-previews.tsx';
import { previewSource } from '../channel-previews/source.ts';
import type { PreviewSource } from '../channel-previews/types.ts';
import { drawPaperCode } from '../paper/drawing.ts';
import { PaperTicket } from '../paper/ticket.tsx';
import { SamsungCard } from '../wallet-previews/samsung/samsung-card.tsx';
import './sync-barcode.ts';
import { PassCard, PassCardStage } from './index.tsx';

const count = (html: string) => html.split(TEST_BAND_COPY).length - 1;
const view = normalize(fixtures.generic, {
  assets,
  now: new Date('2026-10-31T12:00:00Z'),
  timeZone: 'UTC',
});

async function paper(testBand: boolean, size: PaperDesign['size']) {
  const { passJson, manifest, personalization } = await blueprintPass('henrys-blue');
  const design = resolvePaper({ schema: 1, size, barcode: 'qr', kind: 'membership' });
  const content = paperContent({ passJson, manifest, personalization, design });
  return renderToStaticMarkup(
    <PaperTicket
      content={content}
      design={design}
      code="PABCDEFGHIJKLMNOPQRSTUVWXYZ"
      mark="full"
      drawing={drawPaperCode(toSvg, design.barcode, 'PABCDEFGHIJKLMNOPQRSTUVWXYZ')}
      testBand={testBand}
    />,
  );
}

const source: PreviewSource = {
  passJson: EVENT_PASS as unknown as Record<string, unknown>,
  assetBaseUrl: 'http://localhost/assets',
  assetNames: [],
  manifest: EVENT_MANIFEST as unknown as Record<string, unknown>,
  assets: [],
  input: {},
  testBand: true,
};

describe('TEST band', () => {
  it('is text on the Apple card, on each face, only when asked for', () => {
    expect(count(renderToStaticMarkup(<PassCard view={view} testBand />))).toBe(1);
    expect(count(renderToStaticMarkup(<PassCard view={view} face="back" testBand />))).toBe(1);
    expect(count(renderToStaticMarkup(<PassCardStage view={view} toggleId="x" testBand />))).toBe(
      2,
    );
    expect(count(renderToStaticMarkup(<PassCard view={view} />))).toBe(0);
    expect(count(renderToStaticMarkup(<PassCardStage view={view} toggleId="x" />))).toBe(0);
  });

  it('is on Google and Samsung in the console switcher, from the pass source', async () => {
    const user = userEvent.setup();
    render(<ChannelPreviews source={source} apple={<div />} paper={<div />} />);
    await user.click(screen.getByRole('radio', { name: 'Google' }));
    const google = await screen.findByTestId('google-preview', undefined, { timeout: 10_000 });
    expect(google).toHaveTextContent(TEST_BAND_COPY);
    expect(
      render(<SamsungCard data={{ type: 'loyalty', attributes: { title: 'Card' } }} testBand />)
        .container,
    ).toHaveTextContent(TEST_BAND_COPY);
  }, 20_000);

  it('is left off Google and Samsung for any other pass', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChannelPreviews
        source={{ ...source, testBand: undefined }}
        apple={<div />}
        paper={<div />}
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Google' }));
    await screen.findByTestId('google-preview', undefined, { timeout: 10_000 });
    expect(container).not.toHaveTextContent(TEST_BAND_COPY);
    expect(
      render(<SamsungCard data={{ type: 'loyalty', attributes: { title: 'Card' } }} />).container,
    ).not.toHaveTextContent(TEST_BAND_COPY);
  }, 20_000);

  it('is on every page of a printed ticket and in the paper sheet', async () => {
    expect(count(await paper(true, 'cr80'))).toBe(2);
    expect(count(await paper(true, 'a4'))).toBe(1);
    expect(count(await paper(false, 'cr80'))).toBe(0);
    expect(count(await paper(false, 'a4'))).toBe(0);
  });

  it('is carried by the preview source only when asked for', () => {
    const template = { manifest: {}, sample: {}, versions: [], activeVersion: '1' } as never;
    const built = { passJson: {}, assetBaseUrl: '/', assetNames: [] };
    expect(previewSource(built, template, { testBand: true })?.testBand).toBe(true);
    expect(previewSource(built, template)?.testBand).toBeUndefined();
    expect(previewSource(built, template, { testBand: false })?.testBand).toBeUndefined();
  });
});
