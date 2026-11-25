import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EVENT_MANIFEST, EVENT_PASS } from '@/passkit/template/paper-fixtures.ts';
import { toSvg } from '@/shared/pass-view/barcode-svg.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { setBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { renderTags } from '../../tags/test-fixtures.tsx';
import { PaperPreview } from './paper-preview.tsx';
import { DesignerStage } from './stage.tsx';

vi.mock('./preview.tsx', () => ({ DesignerPreview: () => <div data-testid="wallet-card" /> }));

const on = { on: true, source: 'template' };
const channels = (paper: Record<string, unknown>) => () =>
  json({
    channels: null,
    revision: 0,
    effective: { mobile: on, apple: on, google: on, samsung: on, nfc: on, paper },
    defaults: { mobile: 'on', apple: 'on', google: 'on', samsung: 'on', paper: 'off', nfc: 'on' },
    levels: Object.fromEntries(
      ['mobile', 'apple', 'google', 'samsung', 'paper', 'nfc'].map((c) => [c, []]),
    ),
    overrides: { mobile: 0, apple: 0, google: 0, samsung: 0, paper: 0, nfc: 0 },
    overridePasses: 0,
  });

const stage = (paper?: unknown, onPaper?: (p: unknown) => void) => (
  <DesignerStage
    onPaper={onPaper}
    manifest={{ ...EVENT_MANIFEST, ...(paper ? { paper } : {}) } as Record<string, unknown>}
    templateId="t1"
    orgId="o1"
    passJson={EVENT_PASS as unknown as Record<string, unknown>}
    assets={[]}
    assetBase=""
    checking={false}
  />
);

beforeAll(() => setBarcodeEngine(toSvg));

describe('designer Paper tab', () => {
  it('previews the sheet in greyscale on request', async () => {
    const user = userEvent.setup();
    const { container } = renderTags(stage({ schema: 1, size: 'a4', barcode: 'qr' }), {
      '/api/v1/templates/t1/channels': channels(on),
    });
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    await waitFor(() => expect(container.querySelector('.pp-sheet')).not.toBeNull());
    const wrap = () => container.querySelector('.pp-fit')?.parentElement as HTMLElement;
    expect(wrap().style.filter).toBe('');
    await user.click(screen.getByRole('checkbox', { name: 'Greyscale preview' }));
    expect(wrap().style.filter).toBe('grayscale(1)');
  });

  it('shows the wallet card first, then the printed ticket in the block size, switchable per size', async () => {
    const user = userEvent.setup();
    const { container } = renderTags(stage({ schema: 1, size: 'letter', barcode: 'qr' }), {
      '/api/v1/templates/t1/channels': channels({
        on: false,
        source: 'template',
        reason: 'template_off',
      }),
    });
    expect(await screen.findByTestId('wallet-card')).toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    await waitFor(() => expect(container.querySelector('.pp-sheet')).not.toBeNull());
    expect(container.querySelector('.pp-letter')).not.toBeNull();
    expect(screen.getByText('Paper: off for this template')).toBeInTheDocument();
    expect(container.textContent).toContain('Spring Concert');
    expect(container.textContent).not.toContain('SECRET-SCAN-CODE');

    await user.click(screen.getByRole('combobox', { name: /Paper size/ }));
    await user.click(await screen.findByRole('option', { name: 'Card, landscape' }));
    await waitFor(() => expect(container.querySelector('.pp-cr80')).not.toBeNull());
  });

  it('has no Paper tab when printing is off for every organization', async () => {
    const { container } = renderTags(stage(), {
      '/api/v1/templates/t1/channels': channels({
        on: false,
        source: 'platform',
        reason: 'printing_off',
      }),
    });
    expect(await screen.findByTestId('wallet-card')).toBeInTheDocument();
    // PassBook stops it, so it is not the author's to turn on: no tab, no pane, no sheet.
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'Paper' })).toBeNull());
    expect(screen.getByRole('radio', { name: 'Apple' })).toBeChecked();
    expect(container.querySelector('[data-locked]')).toBeNull();
    expect(container.querySelector('.pp-sheet')).toBeNull();
  });

  it('shows a sandbox pass on paper with its TEST band, whatever the organization has off', async () => {
    const { container } = renderTags(
      <PaperPreview
        passJson={EVENT_PASS as unknown as Record<string, unknown>}
        manifest={{ ...EVENT_MANIFEST, paper: { schema: 1, size: 'a4', barcode: 'qr' } }}
        templateId="t1"
        orgId="o1"
        testBand
      />,
      {
        '/api/v1/templates/t1/channels': channels({
          on: false,
          source: 'org',
          reason: 'printing_off',
        }),
      },
    );
    await waitFor(() => expect(container.querySelector('.pp-sheet')).not.toBeNull());
    expect(container.querySelector('.pp-fit > .test-band')).toHaveTextContent(
      'TEST PREVIEW · NOT INSTALLABLE',
    );
    expect(screen.queryByText(/printing off/)).toBeNull();
  });

  it('says when the layout is derived or staff-only', async () => {
    const user = userEvent.setup();
    renderTags(stage({ schema: 1, size: 'a4', barcode: 'qr', holder: false }), {
      '/api/v1/templates/t1/channels': channels(on),
    });
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    expect(await screen.findByText('Staff print only.')).toBeInTheDocument();
    expect(screen.queryByText('Layout from the ticket fields.')).toBeNull();
  });

  it('offers a home sheet for card sizes only, and QR only where Code 128 does not fit', async () => {
    const user = userEvent.setup();
    const onPaper = vi.fn();
    renderTags(stage({ schema: 1, size: 'cr80p', barcode: 'qr' }, onPaper), {
      '/api/v1/templates/t1/channels': channels(on),
    });
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    expect(screen.queryByRole('radio', { name: 'Code 128' })).toBeNull();
    expect(screen.getByText('Code 128 does not fit this size.')).toBeInTheDocument();
    await user.click(await screen.findByRole('combobox', { name: /Holder sheet/ }));
    await user.click(await screen.findByRole('option', { name: 'A4' }));
    expect(onPaper).toHaveBeenLastCalledWith({ sheet: 'a4' });
    await user.click(screen.getByRole('combobox', { name: /Paper size/ }));
    await user.click(await screen.findByRole('option', { name: 'Boarding pass' }));
    expect(onPaper).toHaveBeenLastCalledWith({ size: 'atb' });
  });

  it('edits the block: starts it, then barcode, holder, and shows validation', async () => {
    const user = userEvent.setup();
    const onPaper = vi.fn();
    const first = renderTags(stage(undefined, onPaper), {
      '/api/v1/templates/t1/channels': channels(on),
    });
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    await user.click(await screen.findByRole('button', { name: 'Edit layout' }));
    expect(onPaper).toHaveBeenLastCalledWith({ size: 'a4' });
    first.unmount();

    const second = renderTags(
      stage({ schema: 1, size: 'a4', barcode: 'qr', fields: ['order'] }, onPaper),
      { '/api/v1/templates/t1/channels': channels(on) },
    );
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    expect(
      await screen.findByText('This field carries the scan lookup value.'),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: 'Code 128' }));
    expect(onPaper).toHaveBeenLastCalledWith({ barcode: 'code128' });
    await user.click(screen.getByRole('checkbox', { name: 'Holders can print' }));
    expect(onPaper).toHaveBeenLastCalledWith({ holder: false });
    await user.click(screen.getByRole('combobox', { name: /Paper size/ }));
    await user.click(await screen.findByRole('option', { name: 'Letter' }));
    expect(onPaper).toHaveBeenLastCalledWith({ size: 'letter' });
    await user.click(screen.getByRole('radio', { name: 'Mono' }));
    expect(onPaper).toHaveBeenLastCalledWith({ ink: 'mono' });
    await user.click(screen.getByRole('switch', { name: 'PassBook buddy' }));
    expect(onPaper).toHaveBeenLastCalledWith({ buddy: true });
    await user.click(screen.getByRole('checkbox', { name: 'Fold marks' }));
    expect(onPaper).toHaveBeenLastCalledWith({ fold: false });
    await user.click(screen.getByRole('button', { name: 'Use derived layout' }));
    expect(onPaper).toHaveBeenLastCalledWith(null);
    second.unmount();
  });
});
