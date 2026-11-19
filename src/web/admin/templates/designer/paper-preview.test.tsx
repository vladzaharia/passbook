import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EVENT_MANIFEST, EVENT_PASS } from '@/passkit/template/paper-fixtures.ts';
import { toSvg } from '@/shared/pass-view/barcode-svg.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { setBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { renderTags } from '../../tags/test-fixtures.tsx';
import { DesignerStage } from './stage.tsx';

vi.mock('./preview.tsx', () => ({ DesignerPreview: () => <div data-testid="wallet-card" /> }));

const on = { on: true, source: 'template' };
const channels = (paper: Record<string, unknown>) => () =>
  json({
    channels: null,
    effective: { mobile: on, apple: on, google: on, samsung: on, nfc: on, paper },
  });

const stage = (paper?: unknown) => (
  <DesignerStage
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

    await user.click(screen.getByRole('radio', { name: 'Card' }));
    await waitFor(() => expect(container.querySelector('.pp-cr80')).not.toBeNull());
  });

  it('gives the reason and no ticket when paper is blocked for the platform', async () => {
    const user = userEvent.setup();
    const { container } = renderTags(stage(), {
      '/api/v1/templates/t1/channels': channels({
        on: false,
        source: 'platform',
        reason: 'printing_off',
      }),
    });
    await user.click(await screen.findByRole('radio', { name: 'Paper' }));
    expect(
      await screen.findByText('Paper: printing off for all organizations'),
    ).toBeInTheDocument();
    expect(container.querySelector('.pp-sheet')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Paper size' })).toBeNull();
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
});
