import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { JOIN_COPY } from '@/shared/copy/join.ts';
import { toSvg } from '../../../../shared/pass-view/barcode-svg.ts';
import { setBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import { JoinSign } from './join-sign.tsx';
import { mount, URL_OK } from './join-test-fixtures.tsx';

const require = createRequire(import.meta.url);

/**
 * The sign's QR, rasterised from the data: image's path: closed axis-aligned outlines, filled even-odd
 * (a ray to the right counts the vertical edges it crosses), 2 px a unit with a quiet zone.
 */
function raster(dataUri: string) {
  const svg = Buffer.from(dataUri.split(',')[1] ?? '', 'base64').toString();
  const size = Number(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/.exec(svg)?.[1]);
  const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
  const edges: { x: number; y1: number; y2: number }[] = [];
  for (const outline of d.split('Z')) {
    const pts = [...outline.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      if (q && p[0] === q[0] && p[1] !== q[1])
        edges.push({ x: p[0], y1: Math.min(p[1], q[1]), y2: Math.max(p[1], q[1]) });
    });
  }
  const S = 2;
  const quiet = 16;
  const side = (size + quiet * 2) * S;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const px = x / S - quiet + 0.25;
      const py = y / S - quiet + 0.25;
      let crossings = 0;
      for (const e of edges) if (e.x > px && py >= e.y1 && py < e.y2) crossings++;
      if (crossings % 2) data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  return { data, width: side, height: side, colorSpace: 'srgb' as const };
}

beforeAll(async () => {
  await prepareZXingModule({
    overrides: {
      wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
        .buffer as ArrayBuffer,
    },
    fireImmediately: true,
  });
  setBarcodeEngine(toSvg);
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe('print sign', () => {
  it('says what to do and prints no link text', async () => {
    mount(<JoinSign orgId="org-1" orgName="Dos Olas" url={URL_OK} hasLogo={false} />);
    expect(await screen.findByRole('heading', { name: JOIN_COPY.sign.title })).toBeInTheDocument();
    expect(screen.getByText(JOIN_COPY.sign.scan)).toBeInTheDocument();
    expect(screen.getByText('Dos Olas')).toBeInTheDocument();
    // No URL text: the host alone does not reach the page and the path is the link's secret.
    expect(document.querySelector('code')).toBeNull();
    expect(document.body.textContent).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    // No buddy on the sign: it is for print.
    expect(document.querySelector('[data-buddy]')).toBeNull();
  });

  it('prints the extra line the admin typed', async () => {
    mount(
      <JoinSign
        orgId="org-1"
        orgName="Dos Olas"
        url={URL_OK}
        hasLogo={false}
        line="Free. One card each."
      />,
    );
    expect(await screen.findByText('Free. One card each.')).toBeInTheDocument();
  });

  it('requests the org logo only when the org has one', async () => {
    const none = mount(<JoinSign orgId="org-1" orgName="Dos Olas" url={URL_OK} hasLogo={false} />);
    expect(await screen.findByText('DO')).toBeInTheDocument();
    expect(none.container.querySelector('.jl-logo img')).toBeNull();
    none.unmount();
    const some = mount(<JoinSign orgId="org-1" orgName="Dos Olas" url={URL_OK} hasLogo />);
    await waitFor(() =>
      expect(some.container.querySelector('.jl-logo img')).toHaveAttribute(
        'src',
        '/api/v1/orgs/org-1/branding/logo',
      ),
    );
  });

  it('draws a QR that decodes to the link', async () => {
    mount(<JoinSign orgId="org-1" orgName="Dos Olas" url={URL_OK} hasLogo={false} />);
    const img = await screen.findByRole('img', { name: `QR code for ${URL_OK}` });
    const image = raster(img.getAttribute('src') ?? '');
    const [found] = await readBarcodes(image, { formats: ['QRCode'], tryHarder: true });
    expect(found?.text).toBe(URL_OK);
  });

  it('prints one A5 page with the paper alone', async () => {
    const css = readFileSync('src/web/admin/templates/join/join-sign.css', 'utf8');
    expect(css).toMatch(/@page\s*{\s*size:\s*A5;/);
    expect(css).toMatch(/@media print[\s\S]*body \*\s*{\s*visibility:\s*hidden/);
    expect(css).toMatch(/width:\s*148mm/);
    expect(css).toMatch(/height:\s*210mm/);
  });

  it('has no violations in either theme', async () => {
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      const view = mount(
        <JoinSign orgId="org-1" orgName="Dos Olas" url={URL_OK} hasLogo={false} />,
      );
      await screen.findByRole('img', { name: /QR code for/ });
      await waitFor(async () => expect((await axe(view.container)).violations).toEqual([]));
      view.unmount();
    }
  });
});
